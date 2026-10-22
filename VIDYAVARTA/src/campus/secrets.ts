import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
/** No plaintext fallback. The standalone key is provided out-of-band via CAMPUS_SECRET_KEY. */
export class SecretBroker {
  private path: string;
  constructor(directory: string, private key?: Buffer, private codec?: {encryptString:(s:string)=>Buffer;decryptString:(b:Buffer)=>string}) { mkdirSync(directory,{recursive:true,mode:0o700}); this.path=join(directory,'secrets.enc'); if(key && key.length!==32)throw new Error('CAMPUS_SECRET_KEY must decode to 32 bytes.'); }
  get available() { return Boolean(this.key || this.codec); }
  private decode(): Record<string,string> {
    if (!this.available) throw new Error('Secret broker unavailable. Configure CAMPUS_SECRET_KEY or OS keychain.');
    if (!existsSync(this.path)) return {};
    const bytes=readFileSync(this.path);
    if(this.codec)return JSON.parse(this.codec.decryptString(bytes));
    const d=createDecipheriv('aes-256-gcm',this.key!,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString());
  }
  read(key: string) { return this.decode()[key]; }
  write(key: string,value: string) { const data=JSON.stringify({...this.decode(),[key]:value}); let encrypted: Buffer;
    if(this.codec)encrypted=this.codec.encryptString(data);else{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key!,iv);const payload=Buffer.concat([c.update(data),c.final()]);encrypted=Buffer.concat([iv,c.getAuthTag(),payload]);}
    writeFileSync(this.path,encrypted,{mode:0o600});
  }
}
