# Publicar Velto Export no GitHub Pages

## Pelo navegador (sem instalar nada)

1. Em https://github.com/new, crie um repositório **público** chamado `velto-export` na conta `srkibi`. Escolha **Add a README file** para criar a branch `main`.
2. No novo repositório, clique **Add file → Upload files**. Extraia o ZIP primeiro e envie **os arquivos extraídos**, não o ZIP. Os arquivos `index.html`, `style.css`, `app.js` e `engine.js` devem ficar na raiz do repositório. Inclua também `.nojekyll`, `package.json`, `engine.test.mjs`, `README.md` e `DEPLOY.md`. O fluxo de testes `.github/workflows/test.yml` é opcional para publicação.
3. Clique **Commit changes**.
4. Em **Settings → Pages → Build and deployment**, escolha **Deploy from a branch**, branch `main` e pasta `/(root)`. Salve.
5. Quando o deployment terminar, o endereço será `https://srkibi.github.io/velto-export/`, desde que o nome e a conta sejam os mesmos.

Para atualizar depois, envie os arquivos novos ao mesmo repositório. O Pages publica automaticamente as novas alterações da branch selecionada.

## Verificação local

Com Node.js: `npm test` executa os testes da engine. Para visualizar o site localmente, rode `python -m http.server 8080` nesta pasta e abra `http://localhost:8080/`. **Não abra `index.html` diretamente como file://**, pois os módulos JavaScript precisam ser servidos via HTTP.

O aplicativo renderiza áudio localmente no navegador: não precisa de banco de dados, token do Roblox, backend, variáveis de ambiente nem serviço externo.