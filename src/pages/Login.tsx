import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff, AlertCircle, ChevronRight } from 'lucide-react';
import { useStore } from '../store';
import { TEST_ACCOUNTS, checkCredentials, startSession } from '../lib/auth';
import { Logo } from '../ui/logo';

/** Sign-in screen. Shown for every route while there is no session, so no workspace content renders first. */
export default function Login() {
  const users = useStore(s => s.db.users);
  // Demo convenience: the form opens filled with the fictional admin test account (still editable; never submitted automatically).
  // Held only in component state — the password is never written to storage or logged.
  const [email, setEmail] = useState(TEST_ACCOUNTS[0].email);
  const [password, setPassword] = useState(TEST_ACCOUNTS[0].password);
  const [show, setShow] = useState(false);
  const [errs, setErrs] = useState<{ email?: string; password?: string }>({});
  const [failed, setFailed] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Sign in · SunFrame ERP';
    // Park the URL on #/login so Back/refresh never point at a workspace page while signed out.
    if (window.location.hash !== '#/login') history.replaceState(null, '', '#/login');
    // Prefilled, so Sign in is the next step; focus it rather than the email field.
    document.querySelector<HTMLButtonElement>('.login-submit')?.focus();
    // Back/Forward while signed out land here too; keep the address on #/login.
    const park = () => { if (window.location.hash !== '#/login') history.replaceState(null, '', '#/login'); };
    window.addEventListener('hashchange', park);
    return () => window.removeEventListener('hashchange', park);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errs = {};
    if (!email.trim()) next.email = 'Enter your email.';
    else if (!/^\S+@\S+\.\S+$/.test(email.trim())) next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Enter your password.';
    setErrs(next); setFailed('');
    if (next.email) return emailRef.current?.focus();
    if (next.password) return pwRef.current?.focus();
    const acct = checkCredentials(email, password);
    setPassword(''); // the password is never kept beyond this check
    if (!acct) { setFailed('Incorrect email or password. Check the details and try again.'); return pwRef.current?.focus(); }
    if (!users.some(u => u.id === acct.userId)) { setFailed('This account is no longer set up in SunFrame. Ask an admin.'); return; }
    useStore.getState().setUser(acct.userId);
    history.replaceState(null, '', '#/dashboard');
    startSession(acct.userId);
  };

  const fill = (i: number) => {
    const a = TEST_ACCOUNTS[i];
    setEmail(a.email); setPassword(a.password); setErrs({}); setFailed('');
    pwRef.current?.focus();
  };

  return <div className="login-page">
    <main className="login-card" aria-labelledby="login-h">
      <div className="login-brand"><Logo size={34} /><div><div className="brand-name">SunFrame ERP</div><div className="brand-sub">Solar structures</div></div></div>
      <h1 id="login-h">Welcome back</h1>
      <p className="login-sub">Sign in to SunFrame ERP</p>

      {failed && <div className="login-alert" role="alert"><AlertCircle size={15} /><span>{failed}</span></div>}

      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="login-email">Email<span className="req" aria-hidden>*</span></label>
          <input ref={emailRef} id="login-email" className="input" type="email" autoComplete="username" required value={email}
            aria-invalid={!!errs.email || !!failed || undefined} aria-describedby={errs.email ? 'login-email-err' : undefined}
            onChange={e => { setEmail(e.target.value); if (errs.email) setErrs(x => ({ ...x, email: undefined })); }} />
          {errs.email && <span className="err-text" id="login-email-err">{errs.email}</span>}
        </div>
        <div className="field">
          <label htmlFor="login-pw">Password<span className="req" aria-hidden>*</span></label>
          <div className="pw-wrap">
            <input ref={pwRef} id="login-pw" className="input" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password}
              aria-invalid={!!errs.password || !!failed || undefined} aria-describedby={errs.password ? 'login-pw-err' : undefined}
              onChange={e => { setPassword(e.target.value); if (errs.password) setErrs(x => ({ ...x, password: undefined })); }} />
            <button type="button" className="pw-toggle" onClick={() => setShow(s => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </div>
          {errs.password && <span className="err-text" id="login-pw-err">{errs.password}</span>}
        </div>
        <button type="submit" className="btn btn-primary login-submit">Sign in</button>
      </form>

      <details className="test-accts">
        <summary><ChevronRight size={14} className="chev" />Test accounts</summary>
        <p className="faint tiny">Prototype only — sign-in is simulated in this browser. The form starts with the admin account; choose another to fill it.</p>
        <ul>{TEST_ACCOUNTS.map((a, i) => <li key={a.userId}>
          <button type="button" onClick={() => fill(i)}>
            <span className="ta-name">{users.find(u => u.id === a.userId)?.name ?? a.email}{(() => { const u = users.find(x => x.id === a.userId); const admin = u ? u.role === 'admin' : a.label === 'Admin';
              return <span className={'ta-role' + (admin ? ' admin' : '')}>{admin ? 'Admin' : u?.title || a.label}</span>; })()}</span>
            <span className="ta-cred mono">{a.email} · {a.password}</span>
          </button></li>)}</ul>
      </details>
    </main>
  </div>;
}
