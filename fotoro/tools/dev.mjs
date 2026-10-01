import {spawn} from 'node:child_process';
const child=spawn('pnpm',['dev:fixtures'],{stdio:'inherit',shell:false});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??0));
