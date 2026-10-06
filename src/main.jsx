import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Code2, Database, FilePlus2, History, Lightbulb, LogOut, Plus, Play, Send, Sparkles, Timer, WandSparkles, X } from 'lucide-react';
import { hasSupabaseConfig, supabase } from './supabase';
import { askForHint, completeSession, createFixedQuestionSet, createSession, generateQuestionSet, generateSchema, getQuestionSet, getSessionHistory, getTesterAccess, listOwnedData, requestPasswordReset, runSandbox, saveSchema, signIn, signOut, signUp, updatePassword } from './platformApi';
import './styles.css';

function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState('signin');
  const [authNotice, setAuthNotice] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [isTester, setIsTester] = useState(false);
  const [view, setView] = useState('home');
  const [workspace, setWorkspace] = useState({ schemas: [], sets: [], sessions: [] });
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [activeSession, setActiveSession] = useState(null);
  const [activeSet, setActiveSet] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [hints, setHints] = useState([]);
  const [historyDetail, setHistoryDetail] = useState(null);
  const [startingSetId, setStartingSetId] = useState('');
  const [startingSetStage, setStartingSetStage] = useState('');
  const startSetPending = useRef(false);
  const questionStartedAt = useRef(Date.now());

  useEffect(() => {
    if (!supabase) { setAuthLoading(false); return; }
    supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user ?? null); setAuthLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      setUser(session?.user ?? null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) { setWorkspace({ schemas: [], sets: [], sessions: [] }); return; }
    refreshWorkspace();
  }, [user?.id]);

  useEffect(() => {
    let active = true;
    if (!user) { setIsTester(false); return () => { active = false; }; }
    getTesterAccess().then((access) => { if (active) setIsTester(Boolean(access.isTester)); }).catch(() => { if (active) setIsTester(false); });
    return () => { active = false; };
  }, [user?.id]);

  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 3200); return () => clearTimeout(timer); } }, [toast]);

  async function refreshWorkspace() {
    if (!user) return;
    try { setWorkspace(await listOwnedData(user.id)); } catch (e) { setError(e.message || 'Could not load your workspace.'); }
  }

  async function withBusy(action) {
    setLoading(true); setError('');
    try { return await action(); } catch (e) { setError(e.message || 'Something went wrong.'); return null; } finally { setLoading(false); }
  }

  async function handleAuth(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await withBusy(async () => {
      if (recovering) {
        const password = String(data.get('password'));
        if (password !== data.get('confirmPassword')) throw new Error('The two passwords do not match.');
        await updatePassword(password);
        setRecovering(false);
        setAuthMode('signin');
        setToast('Password updated. You are signed in.');
      } else if (authMode === 'forgot') {
        await requestPasswordReset(String(data.get('email')).trim());
        setAuthNotice('If an account exists for that email, a reset link is on its way. Open it on this device to choose a new password.');
      } else if (authMode === 'signup') {
        const response = await signUp(data.get('email'), data.get('password'));
        setAuthNotice(response.session ? 'Account created and signed in.' : 'Account created. Check your email to confirm the account, then sign in.');
      } else {
        await signIn(data.get('email'), data.get('password'));
        setAuthNotice('Signed in successfully.');
      }
    });
  }

  async function handleSignOut() {
    await withBusy(async () => { await signOut(); setActiveSession(null); setView('home'); });
  }

  async function createGeneratedSet(input) {
    const created = await withBusy(() => generateQuestionSet(input));
    if (!created) return;
    await refreshWorkspace();
    setToast(`${created.questions.length} validated questions generated.`);
    return created;
  }

  async function startSet(set, mode = 'practice') {
    if (startSetPending.current) return;
    startSetPending.current = true;
    setError('');
    setStartingSetId(set.id);
    setStartingSetStage('Loading saved questions…');
    let currentStage = 'loading saved questions';
    try {
      const savedQuestions = await getQuestionSet(set.id, user.id);
      if (savedQuestions.length === 0) throw new Error('This question set has no saved questions. Generate a new set and try again.');
      currentStage = 'opening the practice session';
      setStartingSetStage('Opening practice session…');
      const session = await createSession({ ownerId: user.id, setId: set.id, schemaId: set.schema_id, mode });
      setActiveSession(session); setActiveSet(set); setQuestions(savedQuestions); setCurrentQuestionIndex(0); setQuery(''); setResult(null); setAttempts([]); setHints([]); setView('session');
      questionStartedAt.current = Date.now();
    } catch (e) {
      setError(`Could not finish ${currentStage}: ${e.message || 'request failed.'}`);
    } finally {
      startSetPending.current = false;
      setStartingSetId('');
      setStartingSetStage('');
    }
  }

  async function executeQuery(mode = 'full', selectedText = '', finalize = false) {
    const activeQuestion = questions[currentQuestionIndex];
    const sql = mode === 'selection' ? selectedText : query;
    if (!sql?.trim()) { setError(mode === 'selection' ? 'Select a SQL statement first.' : 'Write a query before running it.'); return; }
    setLoading(true); setError(''); setResult({ status: 'running', message: 'Running your SQL in an isolated PostgreSQL sandbox…' });
    const startedAt = performance.now();
    try {
      const answer = await runSandbox({ schemaId: activeSession.schema_id, sessionId: activeSession.id, questionId: activeQuestion.id, query: sql, executionMode: mode, finalize, taskElapsedMs: Date.now() - questionStartedAt.current });
      const savedAttempt = { ...answer.attempt, submitted_sql: sql, correctness: answer.correct, mismatch_kind: answer.issue, actual_rows: answer.rows, actual_columns: answer.columns, explanation: answer.explanation, elapsed_ms: Math.round(performance.now() - startedAt) };
      setAttempts((items) => [...items, savedAttempt]);
      setResult({ ...answer, status: answer.correct === true ? 'correct' : answer.correct === false ? 'incorrect' : 'result', submittedSql: sql, executionMode: mode, finalized: finalize });
    } catch (e) {
      const failure = { message: e.message || 'Query execution failed.', sqlError: e.message || '', status: 'error', submittedSql: sql, executionMode: mode };
      setResult(failure);
      // SQL failures are also sent to the owner-scoped attempt logger through the run endpoint when possible.
    } finally { setLoading(false); }
  }

  async function requestHint() {
    const activeQuestion = questions[currentQuestionIndex];
    const latest = attempts.at(-1);
    if (!latest) return;
    const hintResponse = await withBusy(() => askForHint({ sessionId: activeSession.id, questionId: activeQuestion.id, attemptId: latest.id }));
    if (hintResponse?.hint) setHints((items) => [...items, hintResponse.hint]);
  }

  async function inspectTable(tableName) {
    const answer = await withBusy(() => runSandbox({ schemaId: activeSession.schema_id, query: `SELECT * FROM "${tableName.replaceAll('"', '""')}" LIMIT 100`, purpose: 'inspect' }));
    return answer;
  }

  async function finishSession() {
    const correct = attempts.filter((item) => item.correctness).length;
    const summary = { attempts: attempts.length, correct, hints: hints.length, completedQuestions: new Set(attempts.filter((item) => item.correctness).map((item) => item.question_id)).size };
    await withBusy(async () => {
      await completeSession(activeSession.id, user.id, summary);
      await refreshWorkspace();
      setHistoryDetail(await getSessionHistory(activeSession.id, user.id));
      setView('session-review');
    });
  }

  async function openHistory(session) {
    const detail = await withBusy(() => getSessionHistory(session.id, user.id));
    if (detail) { setHistoryDetail({ ...detail, session }); setView('session-review'); }
  }

  function nextQuestion() {
    if (currentQuestionIndex + 1 < questions.length) {
      setCurrentQuestionIndex((value) => value + 1); setQuery(''); setResult(null); setHints([]);
      questionStartedAt.current = Date.now();
    } else finishSession();
  }

  if (!hasSupabaseConfig) return <ConfigRequired />;
  if (authLoading) return <div className="center-state"><div className="spinner" />Loading your Learning OS…</div>;
  if (!user || recovering) return <AuthScreen mode={recovering ? 'recovery' : authMode} setMode={(mode) => { setAuthMode(mode); setAuthNotice(''); setError(''); }} onSubmit={handleAuth} loading={loading} error={error} notice={authNotice} />;

  const activeQuestion = questions[currentQuestionIndex];
  const activeSchema = workspace.schemas.find((item) => item.id === (activeSession?.schema_id ?? activeSet?.schema_id));
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Sparkles size={18} /></div><div><strong>Learning OS</strong><span>Assisted independence</span></div></div>
      <div className="account-chip"><div className="avatar">{user.email?.[0]?.toUpperCase() ?? 'L'}</div><div><strong>{user.email}</strong><small>Personal workspace</small></div></div>
      <div className="side-label">Workspace</div>
      <button className={view === 'home' ? 'nav-item active' : 'nav-item'} onClick={() => setView('home')}><Activity size={17} /> Overview</button>
      <button className={view === 'schemas' || view === 'create-schema' ? 'nav-item active' : 'nav-item'} onClick={() => setView('schemas')}><Database size={17} /> My schemas</button>
      <button className={view === 'build-set' ? 'nav-item active' : 'nav-item'} onClick={() => setView('build-set')}><WandSparkles size={17} /> Create practice</button>
      {isTester && <button className={view === 'tester-studio' ? 'nav-item active' : 'nav-item'} onClick={() => setView('tester-studio')}><FilePlus2 size={17} /> Tester studio</button>}
      <button className={view === 'history' || view === 'session-review' ? 'nav-item active' : 'nav-item'} onClick={() => setView('history')}><History size={17} /> Learning history</button>
      <div className="sidebar-foot"><span className="status-dot" /> Private learner workspace<button className="signout-button" onClick={handleSignOut}><LogOut size={14} /> Sign out</button></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><div className="eyebrow">Learning OS / personal workspace</div><h1>{view === 'session' ? 'Practice with purpose.' : view === 'session-review' ? 'Your learning trail.' : view === 'build-set' ? 'Create a practice set.' : view === 'tester-studio' ? 'Curate a learner task.' : view === 'schemas' || view === 'create-schema' ? 'Your schemas and data.' : view === 'history' ? 'Learning history.' : 'Build SQL you can use tomorrow.'}</h1></div><div className="top-actions"><span className="pill"><Database size={14} /> PostgreSQL sandbox</span></div></header>
      {error && <div className="global-error"><X size={17} />{error}<button onClick={() => setError('')}>Dismiss</button></div>}
      {view === 'home' && <HomeView workspace={workspace} onStart={() => setView('build-set')} onSchemas={() => setView('schemas')} onHistory={() => setView('history')} onStartSet={startSet} loading={loading} />}
      {view === 'schemas' && <SchemasView schemas={workspace.schemas} onCreate={() => setView('create-schema')} onGenerate={() => setView('create-schema')} onRefresh={refreshWorkspace} />}
      {view === 'create-schema' && <SchemaCreateView onSave={async (input) => { const saved = await withBusy(() => saveSchema(input)); if (saved) { await refreshWorkspace(); setToast('Schema validated and saved privately.'); setView('schemas'); } }} onGenerate={async (description, difficulty) => { const response = await withBusy(() => generateSchema(description, difficulty)); if (response?.schema) { await refreshWorkspace(); setToast('Generated schema validated and saved.'); setView('schemas'); } }} loading={loading} />}
      {view === 'build-set' && <PracticeSetupView schemas={workspace.schemas} sets={workspace.sets} onGenerate={async (input) => { const created = await createGeneratedSet(input); if (created) await startSet(created.set, input.mode); }} onStartSet={startSet} loading={loading} startingSetId={startingSetId} startingSetStage={startingSetStage} />}
      {view === 'tester-studio' && isTester && <TesterQuestionSetView schemas={workspace.schemas} loading={loading} onCreate={async (input) => { const created = await withBusy(() => createFixedQuestionSet(input)); if (created) { await refreshWorkspace(); setToast(`Curated set assigned to ${created.learnerEmail}.`); setView('home'); } }} />}
      {view === 'session' && activeSession && activeQuestion && <PracticeSession session={activeSession} question={activeQuestion} index={currentQuestionIndex} total={questions.length} schema={activeSchema} query={query} setQuery={(value) => { setQuery(value); setResult(null); }} result={result} attempts={attempts.filter((item) => item.question_id === activeQuestion.id)} hints={hints} loading={loading} onRun={executeQuery} onHint={requestHint} onInspect={inspectTable} onNext={nextQuestion} onExit={() => setView('home')} />}
      {view === 'history' && <HistoryView sessions={workspace.sessions} sets={workspace.sets} schemas={workspace.schemas} onOpen={openHistory} />}
      {view === 'session-review' && <SessionReview detail={historyDetail} questions={questions} onBack={() => setView('history')} />}
      {toast && <div className="toast"><Check size={15} />{toast}</div>}
    </main>
  </div>;
}

function ConfigRequired() { return <div className="auth-shell"><div className="auth-card"><div className="brand-mark large"><Database /></div><p className="eyebrow">Setup required</p><h1>Connect your private workspace</h1><p>Create <strong>.env.local</strong> from <strong>.env.example</strong> and add the Supabase Project URL and publishable/anon key. Restart Vite when saved.</p></div></div>; }

function AuthScreen({ mode, setMode, onSubmit, loading, error, notice }) {
  const description = mode === 'forgot' ? 'Enter your account email and we will send a secure password reset link.' : mode === 'recovery' ? 'Choose a new password for your Learning OS account.' : 'Build SQL skill with a schema, questions matched to your level, and hints that respond to what you actually tried.';
  return <div className="auth-shell"><div className="auth-decoration"><div className="auth-orbit orbit-one"/><div className="auth-orbit orbit-two"/><div className="auth-note note-one">Try a hint, not an answer.</div><div className="auth-note note-two">Learn what you can do alone.</div></div><div className="auth-card"><div className="brand"><div className="brand-mark"><Sparkles size={18} /></div><div><strong>Learning OS</strong><span>Assisted independence</span></div></div><p className="eyebrow">Your private learning space</p><h1>{mode === 'signin' ? 'Welcome back.' : mode === 'signup' ? 'Start your SQL practice.' : mode === 'forgot' ? 'Reset your password.' : 'Choose a new password.'}</h1><p className="auth-lede">{description}</p><form className="auth-form" onSubmit={onSubmit}>{mode !== 'recovery' && <label>Email<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></label>}{mode !== 'forgot' && <label>{mode === 'recovery' ? 'New password' : 'Password'}<input name="password" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} minLength="8" placeholder="At least 8 characters" required /></label>}{mode === 'recovery' && <label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" minLength="8" required /></label>}{mode === 'signin' && <button type="button" className="text-button forgot-link" onClick={() => setMode('forgot')}>Forgot password?</button>}{error && <div className="inline-error">{error}</div>}{notice && <div className="auth-notice">{notice}</div>}<button className="primary-button wide" disabled={loading}>{loading ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Update password'}<ArrowRight size={16} /></button></form>{mode !== 'recovery' && <p className="auth-switch">{mode === 'forgot' ? 'Remembered it?' : mode === 'signin' ? 'New to Learning OS?' : 'Already have an account?'} <button onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>{mode === 'signin' ? 'Create an account' : 'Sign in'}</button></p>}<small className="privacy-note">Your schemas, practice sessions, and history are private to your account.</small></div></div>;
}

function HomeView({ workspace, onStart, onSchemas, onHistory, onStartSet, loading }) {
  return <div className="page-stack"><section className="hero-panel"><div className="hero-copy"><span className="hero-tag"><Sparkles size={14} /> LEARN SQL, KEEP THE THINKING</span><h2>Practice that leaves<br/>you more capable.</h2><p>Choose a schema, set a challenge level, and work through questions with contextual help. Your attempts and learning history stay with your account.</p><button className="primary-button" onClick={onStart}>Create practice set <ArrowRight size={16}/></button></div><div className="hero-graphic"><div className="orbit orbit-a"/><div className="orbit orbit-b"/><div className="hero-code"><span>SELECT</span> your next skill<br/><span>FROM</span> practice<br/><span>WHERE</span> you grow</div><div className="floating-badge"><Check size={15}/> Query skill saved</div></div></section><section className="stat-grid"><StatCard value={workspace.schemas.length} label="Your schemas" icon={<Database size={17}/>} /><StatCard value={workspace.sets.length} label="Question sets" icon={<BookOpen size={17}/>} /><StatCard value={workspace.sessions.length} label="Practice sessions" icon={<History size={17}/>} /></section><div className="section-row"><div><p className="eyebrow">Continue learning</p><h2>Recent question sets</h2></div><button className="text-button" onClick={onHistory}>View history <ArrowRight size={14}/></button></div>{workspace.sets.length ? <div className="card-grid">{workspace.sets.slice(0,3).map((set) => <div className="content-card" key={set.id}><div className="card-icon"><BookOpen size={18}/></div><span className={`level-badge ${set.difficulty}`}>{set.difficulty}</span><h3>{set.question_count} SQL challenges</h3><p>{workspace.schemas.find((schema) => schema.id === set.schema_id)?.name ?? 'Saved schema'} · generated with {set.generation_model || 'your configured model'}</p><button className="card-action" disabled={loading} onClick={() => onStartSet(set)}>Start session <ArrowRight size={15}/></button></div>)}</div> : <div className="empty-state"><div className="empty-icon"><WandSparkles/></div><h3>Your first practice set starts here</h3><p>Add or choose a schema, then generate questions at a level that suits you.</p><button className="secondary-button" onClick={onSchemas}>Explore schemas <ChevronRight size={15}/></button></div>}</div>;
}

function StatCard({ value, label, icon }) { return <div className="stat-card"><span className="stat-icon">{icon}</span><strong>{value}</strong><small>{label}</small></div>; }

function SchemasView({ schemas, onCreate, onGenerate, onRefresh }) {
  return <div className="page-stack"><div className="section-row"><div><p className="eyebrow">Your data, your sandbox</p><h2>Choose or add a schema</h2><p className="section-description">Each schema and its sample data are stored in your account and sandboxed separately during practice.</p></div><div className="button-row"><button className="secondary-button" onClick={onGenerate}><WandSparkles size={15}/> Generate with AI</button><button className="primary-button" onClick={onCreate}><Plus size={16}/> Add my schema</button></div></div>{schemas.length > 0 ? <><div className="section-row compact"><h3>My private schemas</h3><button className="text-button" onClick={onRefresh}>Refresh</button></div><div className="schema-list">{schemas.map((schema) => <div className="schema-list-item" key={schema.id}><div className="schema-icon"><Database size={17}/></div><div className="schema-main"><strong>{schema.name}</strong><span>{schema.dialect} · {schema.table_names?.join(', ') || 'tables validated'} · {schema.source}</span></div><span className="schema-owner">Private</span></div>)}</div></> : <div className="empty-state"><div className="empty-icon"><Database/></div><h3>No schemas yet</h3><p>Add your own PostgreSQL schema and sample data, or describe a domain and let the schema generator create a starting point.</p></div>}</div>;
}

function SchemaCreateView({ onSave, onGenerate, loading }) {
  const [mode, setMode] = useState('manual');
  const [generatedDifficulty, setGeneratedDifficulty] = useState('low');
  const [localError, setLocalError] = useState('');
  async function submitManual(event) { event.preventDefault(); const form = new FormData(event.currentTarget); setLocalError(''); await onSave({ name: form.get('name'), schemaName: form.get('schemaName'), schemaSql: form.get('schemaSql'), dataSql: form.get('dataSql'), dialect: 'PostgreSQL' }); }
  async function submitGenerated(event) { event.preventDefault(); const form = new FormData(event.currentTarget); setLocalError(''); await onGenerate(form.get('description'), generatedDifficulty); }
  return <div className="page-stack narrow-page"><button className="back-link" onClick={() => history.back()}><ArrowLeft size={15}/> Back to schemas</button><div><p className="eyebrow">Bring your own structure</p><h2>Add a schema and its data</h2><p className="section-description">We validate your DDL and seed data in an isolated PostgreSQL sandbox before saving it.</p></div><div className="segmented"><button className={mode === 'manual' ? 'selected' : ''} onClick={() => setMode('manual')}>I have SQL schema/data</button><button className={mode === 'generate' ? 'selected' : ''} onClick={() => setMode('generate')}>Generate a starter schema</button></div>{mode === 'manual' ? <form className="form-card" onSubmit={submitManual}><label>Schema name<input name="name" required placeholder="e.g. Bookstore analytics" /></label><label>PostgreSQL namespace<input name="schemaName" required defaultValue="public" pattern="[A-Za-z_][A-Za-z0-9_]{0,62}" /></label><label>Table definitions<textarea name="schemaSql" required className="code-input" placeholder={'CREATE TABLE customers (id integer, name text, city text);'} /></label><label>Sample data SQL<textarea name="dataSql" className="code-input" placeholder={'INSERT INTO customers VALUES (1, \'Asha\', \'Hyderabad\');'} /></label><p className="form-note">Only schema/data you provide are loaded into a fresh sandbox for a query. Keep credentials and production data out of this field.</p>{localError && <div className="inline-error">{localError}</div>}<button className="primary-button" disabled={loading}>{loading ? 'Validating…' : 'Validate and save'} <Check size={15}/></button></form> : <form className="form-card" onSubmit={submitGenerated}><label>Describe your data domain<textarea name="description" required minLength="8" placeholder="A small library system with members, books, loans, and due dates…" /></label><label>Starter difficulty<select value={generatedDifficulty} onChange={(event) => setGeneratedDifficulty(event.target.value)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><p className="form-note">The configured language model proposes table definitions and sample rows. The sandbox validates them before they are saved.</p>{localError && <div className="inline-error">{localError}</div>}<button className="primary-button" disabled={loading}>{loading ? 'Generating and validating…' : 'Generate schema and data'} <WandSparkles size={15}/></button></form>}</div>;
}

function PracticeSetupView({ schemas, sets, onGenerate, onStartSet, loading, startingSetId, startingSetStage }) {
  const [schemaId, setSchemaId] = useState(schemas[0]?.id ?? '');
  const [difficulty, setDifficulty] = useState('low');
  const [count, setCount] = useState(4);
  const [focus, setFocus] = useState('');
  const [mode, setMode] = useState('practice');
  useEffect(() => { if (!schemaId && schemas[0]) setSchemaId(schemas[0].id); }, [schemas, schemaId]);
  const selectedSchema = schemas.find((schema) => schema.id === schemaId);
  return <div className="page-stack"><section className="setup-layout"><div className="setup-intro"><p className="eyebrow">Build a practice set</p><h2>What would you like to work on?</h2><p>Questions are generated for your chosen schema and difficulty. Every question is checked against the schema/data before it enters your practice set.</p><div className="setup-step"><span>01</span><div><strong>Choose your data</strong><small>Your schema and sample rows become the exercise world.</small></div></div><div className="setup-step"><span>02</span><div><strong>Set your challenge</strong><small>Question difficulty and count belong to you.</small></div></div><div className="setup-step"><span>03</span><div><strong>Practice with responsive hints</strong><small>Hints use your latest query and result, not a fixed script.</small></div></div></div><form className="setup-card" onSubmit={(event) => { event.preventDefault(); onGenerate({ schemaId, difficulty, count: Number(count), focusConcepts: focus.split(',').map((x) => x.trim()).filter(Boolean), mode }); }}><label>Choose schema<select value={schemaId} onChange={(event) => setSchemaId(event.target.value)} required><option value="" disabled>Select one of your schemas</option>{schemas.map((schema) => <option value={schema.id} key={schema.id}>{schema.name}</option>)}</select></label>{!schemas.length && <div className="callout">Add or generate a schema first, then return here.</div>}<fieldset><legend>How challenging?</legend><div className="difficulty-options">{['low','medium','high'].map((level) => <button type="button" key={level} className={difficulty === level ? `difficulty-choice active ${level}` : 'difficulty-choice'} onClick={() => setDifficulty(level)}><strong>{level[0].toUpperCase()+level.slice(1)}</strong><small>{level === 'low' ? 'Filters, simple joins' : level === 'medium' ? 'Aggregates, subqueries' : 'Windows, multi-step reasoning'}</small></button>)}</div></fieldset><label>Number of questions <div className="count-control"><button type="button" onClick={() => setCount((value) => Math.max(1, value - 1))}>−</button><input type="number" min="1" max="20" value={count} onChange={(event) => setCount(Math.max(1, Math.min(20, Number(event.target.value))))}/><button type="button" onClick={() => setCount((value) => Math.min(20, value + 1))}>+</button></div><small className="field-help">Choose from 1 to 20 generated questions.</small></label><label>Optional concept focus<input value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="joins, dates, aggregation…"/><small className="field-help">Comma-separated; the generator treats these as preferences.</small></label><label>Session mode<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="practice">Practice with adaptive hints and correctness feedback</option><option value="removal">No-help removal test</option></select><small className="field-help">Removal mode keeps results visible but withholds correctness until final submission, and disables hints.</small></label><button className="primary-button wide" disabled={loading || !schemas.length}>{loading ? 'Generating and validating…' : 'Generate my questions'} <WandSparkles size={16}/></button></form></section>{selectedSchema && <details className="content-card" style={{ marginTop: 4 }}><summary className="text-button">View schema: {selectedSchema.name}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', fontFamily: 'DM Mono, monospace', fontSize: 11 }}>{selectedSchema.schema_sql}</pre></details>}{sets.length > 0 && <section><div className="section-row"><div><p className="eyebrow">Saved and validated</p><h2>Question sets</h2></div></div><div className="card-grid">{sets.slice(0,6).map((set) => <div className="content-card" key={set.id}><span className={`level-badge ${set.difficulty}`}>{set.difficulty}</span><h3>{set.question_count} questions</h3><p>{schemas.find((schema) => schema.id === set.schema_id)?.name} · {new Date(set.created_at).toLocaleDateString()}</p><button className="card-action" disabled={!!startingSetId} onClick={() => onStartSet(set)}>{startingSetId === set.id ? startingSetStage : 'Start practice'} <ArrowRight size={15}/></button></div>)}</div></section>}</div>;
}

function TesterQuestionSetView({ schemas, loading, onCreate }) {
  const [schemaId, setSchemaId] = useState(schemas[0]?.id ?? '');
  const [difficulty, setDifficulty] = useState('medium');
  const [learnerEmail, setLearnerEmail] = useState('');
  const [questionJson, setQuestionJson] = useState('[\n  {\n    "prompt": "For each department, return its name and employee count, ordered by count descending.",\n    "concepts": ["join", "aggregation", "grouping", "ordering"],\n    "requiresOrder": true,\n    "orderDescription": "Employee count descending, then department name ascending.",\n    "referenceSql": "SELECT d.department_name AS department_name, COUNT(e.employee_id) AS employee_count FROM departments d LEFT JOIN employees e ON e.department_id = d.department_id GROUP BY d.department_name ORDER BY employee_count DESC, department_name ASC",\n    "fields": [\n      { "name": "department_name", "description": "Department name", "aliases": ["name"] },\n      { "name": "employee_count", "description": "Number of employees", "aliases": ["count"] }\n    ]\n  }\n]');
  const [localError, setLocalError] = useState('');

  function submit(event) {
    event.preventDefault();
    setLocalError('');
    try {
      const questions = JSON.parse(questionJson);
      if (!Array.isArray(questions)) throw new Error('Questions must be a JSON array.');
      onCreate({ schemaId, learnerEmail: learnerEmail.trim(), difficulty, questions });
    } catch (error) {
      setLocalError(error.message || 'Question JSON is invalid.');
    }
  }

  return <div className="page-stack narrow-page"><div><p className="eyebrow">Tester tools</p><h2>Assign a validated question set</h2><p className="section-description">Author fixed tasks for a learner account. Reference SQL and expected results stay server-side. The tester email must be allowlisted in both app and function configuration.</p></div><form className="form-card" onSubmit={submit}><label>Learner email<input type="email" required value={learnerEmail} onChange={(event) => setLearnerEmail(event.target.value)} placeholder="learner@example.com" /></label><label>Schema<select required value={schemaId} onChange={(event) => setSchemaId(event.target.value)}><option value="" disabled>Select a schema you own</option>{schemas.map((schema) => <option key={schema.id} value={schema.id}>{schema.name}</option>)}</select></label><label>Difficulty<select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label>Question set JSON<textarea className="code-input" required spellCheck="false" value={questionJson} onChange={(event) => setQuestionJson(event.target.value)} /></label><p className="form-note">Each item needs prompt, concepts, referenceSql, fields, and optional requiresOrder/orderDescription. The reference query is executed against the selected schema before assignment.</p>{localError && <div className="inline-error">{localError}</div>}<button className="primary-button" disabled={loading || !schemas.length}>{loading ? 'Validating and assigning…' : 'Validate and assign'} <Check size={15}/></button></form></div>;
}

function PracticeSession({ session, question, index, total, schema, query, setQuery, result, attempts, hints, loading, onRun, onHint, onInspect, onNext, onExit }) {
  const editorRef = useRef(null);
  const [sampleRows, setSampleRows] = useState(null);
  const [sampleTable, setSampleTable] = useState('');
  const [sampleError, setSampleError] = useState('');
  const [showContract, setShowContract] = useState(false);
  const currentCorrect = result?.correct === true;
  const removalMode = session.mode === 'removal';
  const latestAttempt = attempts.at(-1);
  const hintAlreadyUsed = hints.some((hint) => hint.attempt_id === latestAttempt?.id);
  const hintEnabled = session.mode !== 'removal' && !!result && result.status !== 'running' && !currentCorrect && attempts.length > 0 && !hintAlreadyUsed;
  async function browse(table) { setSampleTable(table); setSampleError(''); const answer = await onInspect(table); if (answer) setSampleRows(answer); else setSampleError('Could not load the table. Verify the data package for this schema.'); }
  function runSelection() { const editor = editorRef.current; if (!editor) return; const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd); onRun('selection', selected); }
  const outputFields = question.output_contract?.fields ?? [];

  return <div className="session-layout"><div className="session-main"><div className="session-head"><button className="back-link" onClick={onExit}><ArrowLeft size={15}/> Leave session</button><span className="session-progress">QUESTION {index + 1} / {total} · {question.difficulty.toUpperCase()}</span></div><div className="session-progress-track"><span style={{width:`${((index+1)/total)*100}%`}}/></div><article className="task-card"><div className="task-meta"><span>{question.concepts?.join(' · ')}</span><span className={`level-badge ${question.difficulty}`}>{question.difficulty}</span></div><h2>{question.prompt}</h2>{outputFields.length > 0 && <div className="output-contract"><button className="text-button" onClick={() => setShowContract((value) => !value)}>{showContract ? 'Hide output checklist' : 'What should the result contain?'}</button>{showContract && <ul>{outputFields.map((field) => <li key={field.name}><strong>{field.name}</strong>{field.description ? ` — ${field.description}` : ''}</li>)}</ul>}</div>}</article><div className="sql-editor-card"><div className="sql-toolbar"><span><Code2 size={15}/> SQL workbench</span><span>{schema?.dialect} · {query.length} chars</span></div><textarea ref={editorRef} value={query} onChange={(event) => setQuery(event.target.value)} spellCheck="false" placeholder="Write a query for this task. Select a SQL fragment below to run just that part."/><div className="sql-toolbar bottom"><span>Full and selected execution use a fresh isolated copy of your data.</span><span>{attempts.length} tries</span></div></div><div className="run-actions"><button className="primary-button" disabled={loading || !query.trim()} onClick={() => onRun('full', query)}><Play size={15}/>{loading ? 'Running…' : 'Run full query'}</button><button className="secondary-button" disabled={loading || !editorRef.current || editorRef.current.selectionStart === editorRef.current.selectionEnd} onClick={runSelection}><Code2 size={15}/> Run selection</button><button className="text-button" onClick={() => setQuery('')}>Clear</button><span className="run-help">Select a standalone SQL fragment to inspect intermediate results.</span></div>
      {result && <ResultPanel result={result}/>}
      {removalMode && result?.status === 'result' && !result.finalized && <div className="next-question-bar removal-submit"><div><Activity size={18}/><span>No correctness feedback has been shown. Submit this as your final answer when ready.</span></div><button className="primary-button" disabled={loading} onClick={() => onRun('full', query, true)}>{loading ? 'Scoring…' : 'Submit final answer'} <Check size={15}/></button></div>}
      {(result?.status === 'correct' || (removalMode && result?.finalized)) && <div className="next-question-bar"><div>{result?.correct ? <Check size={18}/> : <Activity size={18}/>}<span>{removalMode ? 'Final no-help response recorded.' : 'Validated against this generated question’s private answer contract.'}</span></div><button className="primary-button" onClick={onNext}>{index + 1 < total ? 'Next question' : 'Finish session'} <ArrowRight size={15}/></button></div>}
      {result && result.status !== 'correct' && session.mode !== 'removal' && <div className="hint-panel"><div className="hint-panel-title"><div className="hint-orb"><Lightbulb size={18}/></div><div><span className="section-kicker">Contextual coach</span><h3>One next step, based on this attempt.</h3></div></div><p>The coach sees your latest SQL, database error or result mismatch, and previous hints. It must not reveal the full answer.</p><button className="secondary-button" disabled={!hintEnabled || loading} onClick={onHint}><Lightbulb size={15}/>{loading ? 'Thinking…' : hintAlreadyUsed ? 'Run another query for a hint' : 'Ask for a hint'}</button><div className="hint-list">{hints.map((hint, hintIndex) => <div className="hint-entry" key={hint.id}><span>{hint.diagnosis?.supportLevel ?? hintIndex + 1}</span><div><small>{hint.diagnosis?.skillKey ? `${hint.diagnosis.skillKey} · ` : ''}{hint.diagnosis?.category || 'COACH HINT'}</small><p>{hint.hint_text}</p></div></div>)}</div></div>}
      {result?.status === 'correct' && <button className="text-button finish-link" onClick={onNext}>{index + 1 < total ? 'Continue to next question' : 'Finish and review session'} <ArrowRight size={14}/></button>}
    </div><aside className="session-side"><div className="side-card"><div className="side-card-title"><Database size={16}/><strong>Schema</strong><span>{schema?.name}</span></div><pre>{schema?.schema_sql}</pre><button className="text-button" onClick={() => browse(schema?.table_names?.[0])}>Inspect data <ChevronRight size={14}/></button>{schema?.table_names?.length > 0 && <div className="table-tabs">{schema.table_names.map((table) => <button key={table} className={sampleTable === table ? 'active' : ''} onClick={() => browse(table)}>{table}</button>)}</div>}{sampleError && <p className="inline-error">{sampleError}</p>}{sampleRows && <div className="sample-table-wrap"><table><thead><tr>{sampleRows.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{sampleRows.rows.map((row, rowIndex) => <tr key={rowIndex}>{sampleRows.columns.map((column) => <td key={column}>{row[column] == null ? 'NULL' : String(row[column])}</td>)}</tr>)}</tbody></table></div>}</div><div className="side-card"><div className="side-card-title"><Activity size={16}/><strong>This question</strong></div><div className="metric-row"><span>Attempts</span><strong>{attempts.length}</strong></div><div className="metric-row"><span>Hints</span><strong>{hints.length}</strong></div><div className="metric-row"><span>Status</span><strong>{currentCorrect ? 'Correct' : result ? result.status === 'running' ? 'Running' : 'In progress' : 'Not started'}</strong></div></div><div className="side-card session-rules"><strong>{session.mode === 'removal' ? 'No-help session' : 'How hints work'}</strong><p>{session.mode === 'removal' ? 'Hints and answer feedback are disabled for this removal test.' : 'Hints are generated from the latest query/error/result and prior hint history. Ask again after each new attempt.'}</p></div></aside></div>;
}

function summarizeError(message) {
  const text = String(message ?? '');
  const syntax = text.match(/Syntax error at line (\d+) col (\d+)/i);
  if (!syntax) return { summary: text, details: '' };
  const token = text.match(/Unexpected \w+ token: "([^"]+)"/i);
  return { summary: `SQL syntax error at line ${syntax[1]}, column ${syntax[2]}${token ? `: unexpected "${token[1]}"` : ''}.`, details: text };
}

function ResultPanel({ result }) {
  const success = result.status === 'correct';
  const rows = result.rows ?? [];
  const { summary, details } = summarizeError(result.explanation || result.error || result.message);
  return <div className={`result-panel ${success ? 'success' : result.status === 'running' ? 'neutral' : 'error'}`}><div className="result-icon">{success ? <Check size={17}/> : result.status === 'running' ? <Timer size={17}/> : <X size={17}/>}</div><div className="result-content"><strong>{summary}</strong>{details && <details className="error-details"><summary>Technical details</summary><pre>{details}</pre></details>}{result.issue && <small className="mismatch-kind">Diagnosis category: {result.issue}</small>}{rows.length > 0 && <div className="result-table-wrap"><table className="result-table"><thead><tr>{result.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{result.columns.map((column) => <td key={column}>{row[column] == null ? 'NULL' : String(row[column])}</td>)}</tr>)}</tbody></table></div>}</div></div>;
}

function HistoryView({ sessions, sets, schemas, onOpen }) {
  return <div className="page-stack"><div className="section-row"><div><p className="eyebrow">Progress you can revisit</p><h2>Your session history</h2><p className="section-description">Review what you tried, what failed, which hints you received, and what you eventually solved.</p></div></div>{sessions.length ? <div className="history-list">{sessions.map((session) => <button className="history-row" key={session.id} onClick={() => onOpen(session)}><div className="history-icon"><History size={17}/></div><div className="history-main"><strong>{sets.find((set) => set.id === session.set_id)?.question_count ?? 'Practice'} question practice</strong><span>{schemas.find((schema) => schema.id === session.schema_id)?.name} · {new Date(session.started_at).toLocaleString()}</span></div><div className="history-summary"><strong>{session.summary?.correct ?? 0} correct</strong><span>{session.summary?.attempts ?? 0} attempts · {session.summary?.hints ?? 0} hints</span></div><ChevronRight size={17}/></button>)}</div> : <div className="empty-state"><div className="empty-icon"><History/></div><h3>No completed sessions yet</h3><p>Your attempts, errors, hints, and outcomes will appear here.</p></div>}</div>;
}

function SessionReview({ detail, questions, onBack }) {
  if (!detail) return <div className="page-stack"><button className="back-link" onClick={onBack}><ArrowLeft size={15}/> Back to history</button><div className="empty-state"><h3>Session detail unavailable</h3></div></div>;
  const groupedQuestions = new Map();
  for (const attempt of detail.attempts ?? []) { const arr = groupedQuestions.get(attempt.question_id) ?? []; arr.push(attempt); groupedQuestions.set(attempt.question_id, arr); }
  const questionList = detail.questions?.length ? detail.questions : questions;
  return <div className="page-stack"><button className="back-link" onClick={onBack}><ArrowLeft size={15}/> Back to history</button><div className="section-row"><div><p className="eyebrow">Session reflection</p><h2>{detail.session?.summary?.correct ?? 0} questions solved</h2><p className="section-description">Attempts and hints below are ordered by time. Use them to revisit the point where your approach changed.</p></div></div>{[...groupedQuestions.entries()].map(([questionId, questionAttempts]) => { const question = questionList.find((item) => item.id === questionId); return <section className="review-question" key={questionId}><div className="review-question-head"><span className="question-number">Q</span><div><small>{question?.difficulty} · {question?.concepts?.join(' · ')}</small><h3>{question?.prompt ?? 'Practice question'}</h3></div><span className={questionAttempts.some((attempt) => attempt.correctness) ? 'review-status solved' : 'review-status'}>{questionAttempts.some((attempt) => attempt.correctness) ? 'Solved' : 'Still learning'}</span></div><div className="timeline">{questionAttempts.map((attempt) => <div className="timeline-item" key={attempt.id}><span className={attempt.correctness ? 'timeline-dot good' : 'timeline-dot bad'}/><div><div className="timeline-meta"><strong>Attempt {attempt.attempt_number}</strong><span>{new Date(attempt.created_at).toLocaleTimeString()} · {attempt.elapsed_ms ?? '—'} ms</span></div><pre>{attempt.submitted_sql}</pre><p>{attempt.sql_error || (attempt.correctness ? 'Result matched the expected output.' : `Result issue: ${attempt.mismatch_kind || 'not yet matching'}`)}</p></div></div>)}{(detail.hints ?? []).filter((hint) => hint.question_id === questionId).map((hint) => <div className="timeline-item hint-timeline" key={hint.id}><span className="timeline-dot hint-dot"/><div><div className="timeline-meta"><strong>Hint · {hint.diagnosis?.category}</strong><span>{new Date(hint.created_at).toLocaleTimeString()}</span></div><p>{hint.hint_text}</p></div></div>)}</div></section>; })}</div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);
