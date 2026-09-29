import {defineConfig} from 'vite';
import {readFileSync} from 'node:fs';
const pkg=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));
export default defineConfig(({mode})=>({
 define:{__APP_VERSION__:JSON.stringify(pkg.version)},
 build:mode==='demo'?{rollupOptions:{input:'demo.html'}}:undefined,
 server:{host:'127.0.0.1',proxy:mode==='demo'?undefined:{'/api':process.env.VODOG_CONTROL_URL||'http://127.0.0.1:16880'}},
 preview:{host:'127.0.0.1',headers:mode==='demo'?{
  'Content-Security-Policy':"default-src 'self'; connect-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
  'Permissions-Policy':'microphone=(), camera=(), geolocation=()'
 }:undefined}
}));
