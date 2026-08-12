# Vila Real Futsal — migração para banco online no Render

## Arquivos
- `index.html` — aplicativo web responsivo.
- `server.js` — API Express + PostgreSQL + autenticação JWT.
- `package.json` — dependências e comando de inicialização.

## 1. Criar o banco
No Render: **New + Postgres**. Depois, no Web Service, conecte a variável `DATABASE_URL` do banco ao serviço.

## 2. Configurar o Web Service
O serviço precisa ser um **Web Service**, não Static Site.

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`

## 3. Variáveis de ambiente
Configure no Render:

- `DATABASE_URL` — vem do Render Postgres.
- `JWT_SECRET` — uma string longa e aleatória.
- `ADMIN_USER` — usuário atual do administrador.
- `ADMIN_PASSWORD` — senha atual do administrador.
- `ADMIN_EMAIL` — e-mail do administrador.

Para a primeira migração, `ADMIN_USER` e `ADMIN_PASSWORD` precisam permitir o login do administrador que já usa o sistema.

## 4. Primeira migração
Depois do deploy:

1. Abra o sistema no navegador do computador que possui os dados antigos.
2. Faça login como administrador.
3. Se o banco estiver vazio, o sistema detectará os usuários/dados locais e enviará automaticamente o conteúdo para o PostgreSQL.
4. Depois disso, o PostgreSQL passa a ser a fonte central.
5. Teste em uma janela anônima ou em um celular.

## 5. Funcionamento após a migração
- Novo cadastro grava diretamente no PostgreSQL.
- Usuários aparecem automaticamente no painel do administrador.
- Permissões alteradas pelo administrador são gravadas no PostgreSQL.
- Login em qualquer computador/celular recebe as permissões atuais.
- Usuários já conectados são atualizados periodicamente.
- O Dashboard e os demais painéis são controlados pela permissão correspondente.
- O menu mobile continua disponível em telas pequenas.

## Observação de segurança
As senhas não são armazenadas em texto puro no PostgreSQL; o servidor usa bcrypt. O navegador pode manter dados locais legados apenas para a transição/migração.
