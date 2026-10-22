/**
 * Friendly redirect for commands that belong to the developer source.
 * This folder is the zero-install ready package; it already runs the
 * live product. Development happens in the source folder instead.
 */
const line = '--------------------------------------------------------------';
console.log(`
${line}
This folder is the ZERO-INSTALL READY PACKAGE, and since Version 1 it runs
the LIVE product. There is nothing to npm here.

Start it with:  START-VIDYAVARTA.cmd   (or: npm start)

First run: put a .env file next to launcher.cjs (see START-HERE.md).
Your initial admin password is printed in the launcher window and saved
to  data\admin-password.txt .

The developer source (for code changes) is a separate folder:

    cd developer-source
    notepad START-LIVE.txt      <- read this first (10 minutes)
    npm ci --ignore-scripts
    npm rebuild better-sqlite3
    npm run dev:live

${line}`);
