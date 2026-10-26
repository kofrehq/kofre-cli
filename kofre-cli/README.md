# @kofre/cli

Secretos de proyecto cifrados en tu máquina. `kofre push` sube un `.env` cifrado; `kofre pull` lo recupera; `kofre run -- <comando>` inyecta las variables en memoria. El servidor nunca ve los valores en claro.

```bash
npm install -g @kofre/cli
kofre login                      # autoriza esta máquina desde el navegador
kofre init --project <id>        # vincula la carpeta (no guarda secretos)
kofre whoami                     # cuenta, dispositivo, bóveda y proyecto vinculado (alias: status)
kofre push .env --env dev
kofre pull --env dev -o .env
kofre run --env dev -- npm run dev
kofre ui                         # interfaz en la terminal con los mismos comandos
```

`kofre pull` no pisa un `.env` que no generó Kofre ni uno que editaste a mano. Si Kofre trae valores distintos, dice qué variables cambian (sin mostrar valores) y pregunta si guardar una copia antes de actualizar; si lo editaste a mano o no es de Kofre, en la terminal pregunta qué hacer (escribir en `.env.<ambiente>`, reemplazar o cancelar) y, si reemplazas, si guardar una copia; en scripts falla con un aviso. `--force` reemplaza dejando una copia; `--force --no-backup`, sin copia.

Equipos y CI:

```bash
kofre members add colega@empresa.dev --role editor   # muestra su huella para verificarla
kofre members remove colega@empresa.dev              # rota las claves de cifrado del proyecto
kofre tokens create --name ci --envs prod --expires 90
KOFRE_TOKEN=kofre_st_... kofre run --env prod -- npm start   # solo lectura, sin login
kofre history DB_URL --env prod --show
```

Integraciones (descifra en tu máquina y sube con tu propia sesión de cada servicio):

```bash
kofre sync vercel --env prod            # proyecto y equipo de .vercel/project.json; prod → production
kofre sync fly --env prod --app acme    # secretos de Fly (despliega una versión nueva)
kofre sync github --env prod --environment production   # secretos de Actions, sellados con la clave del repo
```

Agentes de IA (Claude Code, Cursor, Claude Desktop):

```bash
kofre guard    # ignora los .env, bloquea su lectura al agente y registra el servidor MCP
kofre unlock   # deja la clave en el llavero para que el agente no pida la contraseña
kofre scan     # .env fuera de .gitignore y credenciales en claro en configs de agentes
```

`kofre mcp` es un servidor MCP por stdio: el agente ve nombres de variables, ejecuta comandos con las variables inyectadas (`kofre_run`, con los valores tachados en la salida) y guarda credenciales nuevas cifradas (`kofre_set`). Ninguna herramienta devuelve valores.

Más comandos: `kofre --help`. Documentación y binarios nativos: https://github.com/kofrehq/kofre-releases
