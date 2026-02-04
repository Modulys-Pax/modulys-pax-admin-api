# Template Frontend (Modulys Pax)

Este diretório contém apenas o `.env.example` de referência para o frontend do projeto gerado.

O frontend em si é copiado de outro repositório (ex.: `template.sourcePath` no cadastro do template). Use este `.env.example` como base para as variáveis `NEXT_PUBLIC_*`:

- **NEXT_PUBLIC_API_URL**: URL do client-backend (login, proxy Core/Chat). Ex.: `http://localhost:4000`
- **NEXT_PUBLIC_CHAT_WS_URL**: URL do modulys-pax-chat-service (Socket.IO). Ex.: `http://localhost:9001`
