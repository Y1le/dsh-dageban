import * as mcp from '@deepseek-ai/dsh-mcp-client';
import {fileURLToPath} from 'node:url';
export const name='dageban';
export const inject=['tools'];
export function apply(ctx){
 return ctx.plugin(mcp,{transport:'stdio',serverName:'dageban',command:process.execPath,
 args:[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],toolCallTimeoutMs:30000,
 failOnStartupError:true});
}

