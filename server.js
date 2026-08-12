const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_JWT_SECRET_IN_RENDER';
const ADMIN_USER = process.env.ADMIN_USER || 'gleuber';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Opala77@2056';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não configurada. Crie um Render Postgres e conecte a variável ao Web Service.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 10
});

const DEFAULT_PERMISSIONS = {
  dashboard: true,
  alunos: true,
  presencas: true,
  carteirinhas: true,
  relatorios: true,
  notificacoes: true,
  backup: false,
  configuracoes: false,
  usuarios: false,
  personalizar: false,
  excluirAlunos: false
};

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    perfil: row.perfil,
    usuario: row.usuario,
    status: row.status,
    permissoes: { ...DEFAULT_PERMISSIONS, ...(row.permissoes || {}) },
    alunosVinculados: Array.isArray(row.alunos_vinculados) ? row.alunos_vinculados : [],
    criadoEm: row.criado_em,
    primeiroAcesso: row.primeiro_acesso
  };
}

function signUser(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE id=$1', [payload.sub]);
    if (!result.rows[0]) return res.status(401).json({ error: 'Usuário não encontrado' });
    const user = result.rows[0];
    if (user.status !== 'aprovado') return res.status(403).json({ error: 'Acesso não autorizado' });
    req.dbUser = user;
    req.user = sanitizeUser(user);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada' });
  }
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      perfil TEXT NOT NULL DEFAULT 'Professor',
      usuario TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'aprovado',
      permissoes JSONB NOT NULL DEFAULT '{}'::jsonb,
      alunos_vinculados JSONB NOT NULL DEFAULT '[]'::jsonb,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      primeiro_acesso BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id=1),
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const admin = await pool.query('SELECT * FROM users WHERE id=$1', ['admin']);
  if (!admin.rows[0]) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await pool.query(
      `INSERT INTO users (id,nome,email,perfil,usuario,senha_hash,status,permissoes,alunos_vinculados,primeiro_acesso)
       VALUES ($1,$2,$3,$4,$5,$6,'aprovado',$7,'[]'::jsonb,false)`,
      ['admin', 'Administrador', process.env.ADMIN_EMAIL || 'admin@vilarealfutsal.com', 'Administrador', ADMIN_USER, hash, JSON.stringify(DEFAULT_PERMISSIONS)]
    );
  }
  await pool.query(`INSERT INTO app_state (id,data) VALUES (1,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
}

async function getState() {
  const state = await pool.query('SELECT data,updated_at FROM app_state WHERE id=1');
  const users = await pool.query('SELECT * FROM users ORDER BY criado_em ASC');
  const data = state.rows[0]?.data || {};
  data.usuarios = users.rows.map(sanitizeUser);
  data.solicitacoesPendentes = [];
  return { data, updatedAt: state.rows[0]?.updated_at || null, userCount: users.rowCount };
}

async function upsertIncomingUsers(client, incomingUsers) {
  if (!Array.isArray(incomingUsers)) return;
  for (const u of incomingUsers) {
    if (!u || !u.id || u.id === 'admin') continue;
    const existing = await client.query('SELECT * FROM users WHERE id=$1', [u.id]);
    const perms = { ...DEFAULT_PERMISSIONS, ...(u.permissoes || {}) };
    const linked = Array.isArray(u.alunosVinculados) ? u.alunosVinculados : [];
    if (existing.rows[0]) {
      if (u.senha) {
        const hash = await bcrypt.hash(String(u.senha), 12);
        await client.query(`UPDATE users SET nome=$2,email=$3,perfil=$4,usuario=$5,status=$6,permissoes=$7,alunos_vinculados=$8,primeiro_acesso=$9,senha_hash=$10 WHERE id=$1`,
          [u.id,u.nome,u.email,u.perfil || 'Professor',u.usuario,u.status || 'aprovado',JSON.stringify(perms),JSON.stringify(linked),u.primeiroAcesso !== false,hash]);
      } else {
        await client.query(`UPDATE users SET nome=$2,email=$3,perfil=$4,usuario=$5,status=$6,permissoes=$7,alunos_vinculados=$8,primeiro_acesso=$9 WHERE id=$1`,
          [u.id,u.nome,u.email,u.perfil || 'Professor',u.usuario,u.status || 'aprovado',JSON.stringify(perms),JSON.stringify(linked),u.primeiroAcesso !== false]);
      }
    } else if (u.senha && u.email && u.usuario) {
      const hash = await bcrypt.hash(String(u.senha), 12);
      await client.query(`INSERT INTO users (id,nome,email,perfil,usuario,senha_hash,status,permissoes,alunos_vinculados,criado_em,primeiro_acesso)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [u.id,u.nome,u.email,u.perfil || 'Professor',u.usuario,hash,u.status || 'aprovado',JSON.stringify(perms),JSON.stringify(linked),u.criadoEm || new Date().toISOString(),u.primeiroAcesso !== false]);
    }
  }
}

app.get('/api/health', async (req,res) => {
  try { await pool.query('SELECT 1'); res.json({ok:true}); }
  catch(e){ res.status(503).json({ok:false,error:'Banco indisponível'}); }
});

app.post('/api/auth/login', async (req,res) => {
  try {
    const login = String(req.body.login || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');
    if (!login || !senha) return res.status(400).json({error:'Informe usuário/e-mail e senha'});
    const result = await pool.query('SELECT * FROM users WHERE LOWER(usuario)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1', [login]);
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(senha, row.senha_hash))) return res.status(401).json({error:'Usuário/e-mail ou senha inválidos'});
    if (row.status !== 'aprovado') return res.status(403).json({error:'Seu acesso não está autorizado'});
    const user = sanitizeUser(row);
    const state = await getState();
    res.json({token:signUser(user),user,state:state.data,serverUserCount:state.userCount});
  } catch(e) { console.error(e); res.status(500).json({error:'Erro ao realizar login'}); }
});

app.post('/api/auth/register', async (req,res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {nome,email,perfil,senha} = req.body || {};
    if (!nome || !email || !senha) throw new Error('Preencha todos os campos');
    const exists = await client.query('SELECT 1 FROM users WHERE LOWER(email)=LOWER($1)', [email]);
    if (exists.rows[0]) return res.status(409).json({error:'Este e-mail já está cadastrado no sistema'});
    const seqResult = await client.query(`SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(usuario,'\\D','','g'),'') AS INTEGER)),0)+1 AS n FROM users WHERE usuario LIKE 'usuario%'`);
    const n = Number(seqResult.rows[0].n || 1);
    const usuario = 'usuario' + String(n).padStart(4,'0');
    const id = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    const hash = await bcrypt.hash(String(senha),12);
    const basic = {...DEFAULT_PERMISSIONS};
    if (perfil === 'Pai') { basic.alunos=false; basic.presencas=false; basic.carteirinhas=false; basic.relatorios=false; }
    await client.query(`INSERT INTO users (id,nome,email,perfil,usuario,senha_hash,status,permissoes,alunos_vinculados,primeiro_acesso)
      VALUES ($1,$2,$3,$4,$5,$6,'aprovado',$7,'[]'::jsonb,true)`,
      [id,nome,email,perfil || 'Professor',usuario,hash,JSON.stringify(basic)]);
    await client.query('COMMIT');
    res.json({ok:true,usuario,user:{id,nome,email,perfil:perfil||'Professor',usuario,status:'aprovado',permissoes:basic,alunosVinculados:[],primeiroAcesso:true}});
  } catch(e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({error:'Usuário ou e-mail já cadastrado'});
    console.error(e); res.status(400).json({error:e.message || 'Não foi possível criar a conta'});
  } finally { client.release(); }
});

app.get('/api/me', auth, async (req,res) => res.json({user:req.user}));

app.get('/api/state', auth, async (req,res) => {
  try { res.json(await getState()); }
  catch(e){ console.error(e); res.status(500).json({error:'Erro ao carregar dados'}); }
});

app.put('/api/state', auth, async (req,res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const incoming = req.body?.data;
    if (!incoming || typeof incoming !== 'object') throw new Error('Dados inválidos');
    if (req.dbUser.perfil !== 'Administrador') {
      // Usuários comuns não podem alterar a lista de usuários/permissões pelo estado global.
      delete incoming.usuarios;
      delete incoming.config?.senhaMaster;
    }
    await upsertIncomingUsers(client, incoming.usuarios);
    if (req.dbUser.perfil === 'Administrador' && Array.isArray(incoming.usuarios)) {
      const ids = incoming.usuarios.map(u => u && u.id).filter(Boolean).filter(id => id !== 'admin');
      if (ids.length) {
        await client.query(`DELETE FROM users WHERE id <> 'admin' AND id <> ALL($1::text[])`, [ids]);
      } else {
        await client.query(`DELETE FROM users WHERE id <> 'admin'`);
      }
    }
    const safeState = {...incoming};
    delete safeState.usuarios;
    delete safeState.solicitacoesPendentes;
    await client.query(`UPDATE app_state SET data=$1,updated_at=NOW() WHERE id=1`, [JSON.stringify(safeState)]);
    await client.query('COMMIT');
    res.json(await getState());
  } catch(e) {
    await client.query('ROLLBACK'); console.error(e); res.status(400).json({error:e.message || 'Erro ao salvar dados'});
  } finally { client.release(); }
});

app.delete('/api/users/:id', auth, async (req,res) => {
  if (req.dbUser.perfil !== 'Administrador') return res.status(403).json({error:'Apenas administradores'});
  if (req.params.id === 'admin') return res.status(400).json({error:'Não é possível excluir o administrador'});
  await pool.query('DELETE FROM users WHERE id=$1',[req.params.id]);
  res.json({ok:true});
});

// Compatibilidade: o frontend antigo pode continuar usando localStorage, mas o banco é a fonte central.
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'index.html')));

ensureSchema().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Vila Real Futsal API/Web rodando na porta ${PORT}`));
}).catch(err => { console.error('Falha ao iniciar:',err); process.exit(1); });
