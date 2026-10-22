import { useState } from 'react';
import { GraduationCap, LogIn, ShieldCheck } from 'lucide-react';
import { auth, type SessionUser } from './api';
export function Login({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const signIn = async (key: string) => { setBusy(key); setError(''); try { const { user } = await auth.login(username, password); onSignedIn(user); } catch (e) { setError((e as Error).message); } finally { setBusy(''); } };
  return <div className="login-screen"><div className="login-card" data-testid="login-screen">
    <div className="brand-mark login-mark"><GraduationCap size={30} /></div>
    <h1 className="login-title">VidyaVarta<span className="brand-period">.</span></h1>
    <p className="login-sub">Sign in to the campus office. Everything you do inside is recorded under your name in the audit chain.</p>
    <form className="login-form" onSubmit={e => { e.preventDefault(); void signIn('form'); }}>
      <label>Username<input data-testid="login-user" required value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" placeholder="e.g. admin" /></label>
      <label>Password<input data-testid="login-pass" type="password" required value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label>
      {error && <div className="login-error" role="alert">{error}</div>}
      <button className="button full" data-testid="login-submit" disabled={!!busy || !username || !password} type="submit"><LogIn size={15} /> {busy === 'form' ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <p className="tiny muted">First start? The initial <code>admin</code> password is printed by the server and saved to <code>admin-password.txt</code> in the data folder. Create your team accounts from the app afterwards.</p>
    <p className="tiny muted login-foot"><ShieldCheck size={13} /> Local-first · loopback only · every sign-in, failure and lock is audited</p>
  </div></div>;
}
