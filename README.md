# Nexus Chat — Discord-like (.exe)

App estilo Discord **completo**, com:
- **Servidores** (código de convite) + **canais de texto e voz**
- **Chat em tempo real** (mensagens persistidas em JSON local)
- **Call de voz** com amigos (WebRTC mesh, STUN Google, áudio com echoCancellation/noiseSuppression)
- **Compartilhamento de tela**: **Tela do PC inteira** ou **janela de app** — seletor com thumbnails (Electron `desktopCapturer`) ou picker do navegador
- **Seleção de qualidade de imagem**: `480p · 15fps` · `720p · 30fps` · `1080p · 30/60fps` · `Original` — controla `maxBitrate` e `maxFramerate` via `RTCRtpSender.setParameters` e captura `width/height/frameRate`
- **Servidor roda no PC de quem abrir a call** — o host clica em **Hospedar → Iniciar servidor** e o `HostServer` (WS + HTTP) sobe em `ws://<IP_LOCAL>:8765`. Amigos entram com `ws://IP_DO_HOST:8765` sem conta, só nome.

## Como usar (build .exe)

1. **Instalar e gerar o .exe**:
   ```bash
   cd discord-clone
   bun install
   bunx vite build && bun run build:electron
   bunx electron-builder --win nsis --x64 --publish never
   # saída: release/Nexus Chat Setup 1.0.0.exe  (~81 MB)  e  release/win-unpacked/Nexus Chat.exe
   ```

2. **Rodar sem instalar** (dev):
   ```bash
   bun run build:electron && bunx vite build
   npx electron .
   # ou em dev com hot reload:
   # terminal 1: bunx vite  (http://localhost:5173)
   # terminal 2: npx tsc -p tsconfig.electron.json --watch  +  NODE_ENV=development electron .
   ```

3. **Hospedar uma call**:
   - Abra o .exe → no login, veja **Status do servidor local** → escolha porta (padrão `8765`) → **Iniciar servidor**
   - Copie o convite com **🔗 Convite** (ex: `ws://192.168.1.10:8765`) e envie aos amigos
   - Libere a porta no **Firewall do Windows** se amigos estiverem em outra rede (ou use mesma Wi-Fi/rede local)

4. **Entrar como convidado**:
   - Cole o `ws://IP:porta` no campo **Servidor do host**, escolha seu nome e **Entrar no Nexus →**

5. **Na call**:
   - Crie canais `# texto` e `🔊 voz` no servidor
   - Clique duplo no canal de voz ou **Entrar** → permite microfone
   - **🎙️/🎧** mute/deafen, **🖥️ Compartilhar tela** → escolha *Tela do PC* vs *Janela de App*, qualidade e se inclui áudio do sistema
   - **Qualidade**: troque ao vivo no seletor da sidebar ou no picker; bitrate é reaplicado a todos os `RTCPeerConnection`s

## Arquitetura

- **Electron main** (`electron/main.ts`): cria `BrowserWindow`, expõe `desktopCapturer`, inicia `HostServer`
- **HostServer** (`electron/server.ts`): `ws` + `http` (health/invite), estado em memória + persistência `userData/nexus/data.json`, signaling WebRTC (`offer/answer/ice` repassados)
- **Renderer** (`src/app.ts` + `styles.css`): SPA vanilla TS, mesh WebRTC (`RTCPeerConnection` por par), `getUserMedia` áudio, `getDisplayMedia` / `chromeMediaSource: desktop`, grid de voz + stage de tela, typing indicators
- **ICE**: STUN `stun.l.google.com:19302` (adicionar TURN próprio se precisar atravessar NAT simétrico)

## Dicas

- **Tela preta na call?** Verifique permissão de microfone/tela no Windows/Antivírus.
- **Amigo não conecta?** Confirme IP, porta e firewall. Para internet externa, encaminhe a porta no roteador ou use VPN/Tailscale.
- **Qualidade alta engasga?** Troque para `720p` ou `480p` — o host não re-encoda, cada peer negocia bitrate direto (mesh).

## Scripts

- `bun run build` — build do renderer + tsc do electron
- `bunx electron-builder --win nsis --x64` — gera o instalador `.exe`
