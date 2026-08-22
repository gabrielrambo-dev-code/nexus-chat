# Nexus Chat — Discord-like (.exe)

App estilo Discord **completo**, com:
- **Servidores** (código de convite) + **canais de texto e voz**
- **Chat em tempo real** (mensagens persistidas em JSON local)
- **Call de voz** com amigos (WebRTC mesh, STUN Google, áudio com echoCancellation/noiseSuppression)
- **Compartilhamento de tela**: **Tela do PC inteira** ou **janela de app** — seletor com thumbnails (Electron `desktopCapturer`) ou picker do navegador
- **Seleção de qualidade de imagem**: `480p · 15fps` · `720p · 30fps` · `1080p · 30/60fps` · `Original` — controla `maxBitrate` e `maxFramerate` via `RTCRtpSender.setParameters` e captura `width/height/frameRate`
- **Servidor roda no PC de quem abrir a call** — o host clica em **Hospedar → Iniciar servidor** e o `HostServer` (WS + HTTP) sobe em `ws://<IP_LOCAL>:8765`. Amigos entram com `ws://IP_DO_HOST:8765` sem conta, só nome.
- **Auto-atualização direta com o Git** — via `electron-updater` + GitHub Releases e fallback `git pull`

Repositório: **https://github.com/gabrielrambo-dev-code/nexus-chat**

## Como usar (build .exe)

1. **Instalar e gerar o .exe**:
   ```bash
   cd discord-clone
   bun install
   bunx vite build && bun run build:electron
   bunx electron-builder --win nsis --x64 --publish never
   # saída: release/Nexus Chat Setup 1.0.1.exe  (~78 MB)  e  release/win-unpacked/Nexus Chat.exe
   ```

2. **Rodar sem instalar** (dev):
   ```bash
   bun run build:electron && bunx vite build
   npx electron .
   ```

3. **Hospedar uma call**:
   - Abra o .exe → no login, veja **Status do servidor local** → escolha porta (padrão `8765`) → **Iniciar servidor**
   - Copie o convite com **🔗 Convite** (ex: `ws://192.168.1.10:8765`) e envie aos amigos
   - Libere a porta no **Firewall do Windows** se amigos estiverem em outra rede (ou use mesma Wi-Fi)

4. **Entrar como convidado**:
   - Cole o `ws://IP:porta` no campo **Servidor do host**, escolha seu nome e **Entrar no Nexus →**

5. **Na call**:
   - Crie canais `# texto` e `🔊 voz` no servidor
   - Clique duplo no canal de voz ou **Entrar** → permite microfone
   - **🎙️/🎧** mute/deafen, **🖥️ Compartilhar tela** → escolha *Tela do PC* vs *Janela de App*, qualidade e se inclui áudio do sistema
   - **Qualidade**: troque ao vivo no seletor da sidebar ou no picker; bitrate é reaplicado a todos os `RTCPeerConnection`s

## Atualização direta com o Git / GitHub

### No app instalado (.exe)
- O app checa automaticamente ao iniciar (e a cada 1h) por novas releases no GitHub via `electron-updater`
- Clique em **⬇️ Atualizar** na barra superior para verificar manualmente
- Se houver atualização: **Baixar → Reiniciar e instalar** (instalação silenciosa, preserva dados em `userData/nexus/data.json`)
- Config em `package.json`:
  ```json
  "publish": [{ "provider": "github", "owner": "gabrielrambo-dev-code", "repo": "nexus-chat" }]
  ```

### Em modo dev / código-fonte
- Dentro do app: **⬇️ Atualizar → git pull (dev)** executa `git pull --ff-only` no repositório local
- Manual no terminal:
  ```bash
  git pull origin main
  bun install
  bunx vite build && bun run build:electron
  bunx electron-builder --win nsis --x64
  ```

### Publicar nova versão
```bash
# 1. bump version em package.json
git add . && git commit -m "feat: v1.0.2"
git tag v1.0.2 && git push origin main --tags
# 2. GitHub Actions (release.yml) builda o .exe e publica a Release automaticamente
# ou local:
bunx vite build && bun run build:electron
bunx electron-builder --win nsis --x64 --publish always  # precisa GH_TOKEN
```

## Arquitetura

- **Electron main** (`electron/main.ts`): cria `BrowserWindow`, expõe `desktopCapturer`, inicia `HostServer`, corrige freeze ao fechar (terminate + timeout)
- **HostServer** (`electron/server.ts`): `ws` + `http` (health/invite), estado em memória + persistência `userData/nexus/data.json`, signaling WebRTC (`offer/answer/ice` repassados)
- **Updater** (`electron/updater.ts`): `electron-updater` + GitHub API fallback + `git pull`
- **Renderer** (`src/app.ts` + `styles.css`): SPA vanilla TS, mesh WebRTC (`RTCPeerConnection` por par), `getUserMedia` áudio, `getDisplayMedia` / `chromeMediaSource: desktop`, grid de voz + stage de tela, cleanup `beforeunload` para não travar ao fechar
- **ICE**: STUN `stun.l.google.com:19302` (adicionar TURN próprio se precisar atravessar NAT simétrico)

## Fix travamento ao fechar
- `HostServer.stop()` agora usa `terminate()` + `Promise.race` com timeout 1.2s + `closeAllConnections`
- `main.ts` com `single instance lock`, `win.on('close')` com `e.preventDefault()` e shutdown gracioso, fallback `app.exit(0)` após 1.5s
- Renderer com `beforeunload`/`pagehide` que fecha `ws`, `RTCPeerConnections`, `MediaStreams` e `AudioContext`

## Scripts

- `bun run build` — build do renderer + tsc do electron
- `bunx electron-builder --win nsis --x64` — gera o instalador `.exe`
- `bunx electron-builder --win nsis --x64 --publish always` — publica no GitHub Releases (usa `GH_TOKEN`)
