import { defineConfig,loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({mode})=>{const env=loadEnv(mode,process.cwd(),'VITE_');const target=env.VITE_FOTORO_API||'http://127.0.0.1:8790';return {plugins:[react()],server:{port:4310,strictPort:true,host:'127.0.0.1',proxy:{'/v1':target,'/__fixtures':target}},worker:{format:'es'},build:{target:'es2022'}};});
