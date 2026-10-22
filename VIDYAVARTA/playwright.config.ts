import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const dataDir = resolve('.e2e-live-data');
// Boots the live app itself (vite dev + campus bridge on a fresh data dir) and runs the browser flows against it.
export default defineConfig({
  testDir:'./tests',testMatch:'campus.e2e.spec.ts',workers:1,timeout:60000,
  use:{baseURL:process.env.CAMPUS_E2E_URL??'http://127.0.0.1:5173',headless:true,viewport:{width:1440,height:1000},launchOptions:{args:['--no-sandbox']},screenshot:'only-on-failure'},
  webServer:{
    command:'npm run dev:live',url:'http://127.0.0.1:5173',reuseExistingServer:true,timeout:120000,
    env:{...process.env,CAMPUS_DATA_DIR:dataDir,CAMPUS_ADMIN_PASSWORD:process.env.CAMPUS_ADMIN_PASSWORD??'e2e-operator-password',CAMPUS_NO_OPEN:'1'}
  },
  reporter:[['list']]
});
