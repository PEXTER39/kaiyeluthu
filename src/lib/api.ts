/**
 * Data layer. Function names match the REST API served by /server/index.mjs.
 * The browser keeps a local copy (localStorage) so screens stay fast, while the
 * server is the master copy for students, plans, OTP login, progress and submissions.
 */
import { siteConfig } from "@/config/site";
import { getPlan } from "@/data/course";
import type { AppEvent, Certificate, Enrollment, EventType, Payment, PlanId, Student, Submission, WatchProgress } from "./types";

interface DB {
  students: Student[]; enrollments: Enrollment[]; payments: Payment[]; watch: WatchProgress[];
  submissions: Submission[]; certificates: Certificate[]; events: AppEvent[];
}
const KEY = "kc_db_v1";
const SESSION_KEY = "kc_student";
const empty = (): DB => ({ students: [], enrollments: [], payments: [], watch: [], submissions: [], certificates: [], events: [] });
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const now = () => new Date().toISOString();

function read(): DB {
  if (typeof window === "undefined") return empty();
  try { return { ...empty(), ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return empty(); }
}
function write(db: DB) { localStorage.setItem(KEY, JSON.stringify(db)); }

/* ---------- Events ---------- */
export function logEvent(type: EventType, meta?: Record<string, unknown>, studentId?: string) {
  if (typeof window === "undefined") return;
  const db = read();
  db.events.push({ id: uid(), type, meta, studentId, at: now() });
  write(db);
}

/* ---------- Server calls ---------- */
interface Bundle {
  student: Student;
  enrollment: Enrollment | null;
  watch: { studentId: string; sessionId: number; ranges: [number, number][]; duration: number; updatedAt: string }[];
  submissions: Submission[];
  certificates: Certificate[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { ok: boolean; status: number; data: any };

async function call(path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<Reply> {
  try {
    const init: RequestInit = { method: "GET", credentials: "same-origin" };
    if (body !== undefined) {
      init.method = "POST";
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
      if (opts.keepalive) init.keepalive = true;
    }
    const res = await fetch("/api" + path, init);
    let data: unknown = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null }; // server not reachable
  }
}

const toRanges = (secs: number[]): [number, number][] => {
  const out: [number, number][] = [];
  for (const n of [...secs].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n <= last[1] + 1) last[1] = Math.max(last[1], n); else out.push([n, n]);
  }
  return out;
};
const fromRanges = (ranges: [number, number][], cap: number) => {
  const out: number[] = [];
  for (const [a, b] of ranges) for (let n = a; n <= b && out.length < cap; n++) out.push(n);
  return out;
};

/** Copy the server's version of this student's data into the local copy. */
function applyBundle(b: Bundle) {
  const db = read();
  const si = db.students.findIndex((x) => x.id === b.student.id);
  if (si >= 0) db.students[si] = b.student; else db.students.push(b.student);
  db.enrollments = db.enrollments.filter((e) => e.studentId !== b.student.id);
  if (b.enrollment) db.enrollments.push(b.enrollment);

  for (const w of b.watch) {
    const secs = fromRanges(w.ranges, 20000);
    const local = db.watch.find((x) => x.studentId === w.studentId && x.sessionId === w.sessionId);
    if (!local) db.watch.push({ studentId: w.studentId, sessionId: w.sessionId, watchedSeconds: secs, duration: w.duration, updatedAt: w.updatedAt });
    else { local.watchedSeconds = Array.from(new Set([...local.watchedSeconds, ...secs])).sort((x, y) => x - y); local.duration = w.duration || local.duration; }
  }
  for (const sub of b.submissions) {
    const local = db.submissions.find((x) => x.studentId === sub.studentId && x.assignmentId === sub.assignmentId);
    if (!local || local.id === sub.id || local.createdAt <= sub.createdAt) {
      db.submissions = db.submissions.filter((x) => !(x.studentId === sub.studentId && x.assignmentId === sub.assignmentId));
      db.submissions.push(sub);
    }
  }
  for (const c of b.certificates) if (!db.certificates.some((x) => x.studentId === c.studentId)) db.certificates.push(c);
  write(db);
  localStorage.setItem(SESSION_KEY, b.student.id);
}

/* ---------- Auth (email OTP, checked on the server) ---------- */
export function getCurrentStudent(): Student | null {
  if (typeof window === "undefined") return null;
  const id = localStorage.getItem(SESSION_KEY);
  return read().students.find((s) => s.id === id) ?? null;
}

export type OtpRequestResult =
  | { ok: true; devOtp?: string }
  | { ok: false; error: "not_found" | "wait" | "send_failed" | "offline" | "other"; retryAfter?: number; message?: string };

export async function requestOtp(email: string): Promise<OtpRequestResult> {
  const r = await call("/auth/request-otp", { email: email.trim() });
  if (r.status === 0) return { ok: false, error: "offline" };
  if (r.data?.ok) return { ok: true, ...(r.data.devOtp ? { devOtp: String(r.data.devOtp) } : {}) };
  const error = r.data?.error;
  if (error === "not_found" || error === "wait" || error === "send_failed") return { ok: false, error: error as "not_found" | "wait" | "send_failed", retryAfter: r.data?.retryAfter };
  return { ok: false, error: "other", message: r.data?.message };
}

export async function verifyOtp(email: string, otp: string): Promise<Student | null> {
  const r = await call("/auth/verify-otp", { email: email.trim(), otp: otp.trim() });
  if (!r.data?.ok) return null;
  applyBundle(r.data.bundle as Bundle);
  return (r.data.bundle as Bundle).student;
}

let sessionCheck: { at: number; p: Promise<void> } | null = null;
/** Ask the server who is logged in and refresh the local copy. Logs the browser out if the server session ended. */
export function syncSession(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (sessionCheck && Date.now() - sessionCheck.at < 10_000) return sessionCheck.p;
  const p = (async () => {
    if (!localStorage.getItem(SESSION_KEY)) return;
    const r = await call("/me");
    if (r.status === 401) { localStorage.removeItem(SESSION_KEY); return; }
    if (r.ok && r.data?.bundle) applyBundle(r.data.bundle as Bundle);
  })();
  sessionCheck = { at: Date.now(), p };
  return p;
}

export async function logout() {
  const s = getCurrentStudent();
  if (s) await pushSync(s.id, true);
  await call("/auth/logout", {});
  sessionCheck = null;
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(KEY); // do not leave a student's data behind on a shared computer
}

/* ---------- Saving progress to the server ---------- */
let syncTimer: ReturnType<typeof setTimeout> | undefined;
export function pushSync(studentId: string, immediate = false): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  clearTimeout(syncTimer);
  const run = async () => {
    const db = read();
    const student = db.students.find((x) => x.id === studentId);
    await call("/sync", {
      watch: db.watch.filter((w) => w.studentId === studentId).map((w) => ({ sessionId: w.sessionId, ranges: toRanges(w.watchedSeconds), duration: w.duration })),
      submissions: db.submissions.filter((x) => x.studentId === studentId),
      certificates: db.certificates.filter((c) => c.studentId === studentId),
      profile: student ? { name: student.name, phone: student.phone } : undefined,
    }, { keepalive: true });
  };
  if (immediate) return run();
  syncTimer = setTimeout(() => { void run(); }, 6000);
  return Promise.resolve();
}
if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    const s = getCurrentStudent();
    if (s) void pushSync(s.id, true);
  });
}

/* ---------- Enrollment & payments ---------- */
export function getEnrollment(studentId: string) { return read().enrollments.find((e) => e.studentId === studentId) ?? null; }

export type PurchaseResult = { ok: true; loggedIn: boolean } | { ok: false; error: string };

/** Saves a successful payment on the server. New students are logged in straight away. */
export async function recordPurchase(input: { name: string; email: string; phone: string; planId: PlanId; providerPaymentId?: string }): Promise<PurchaseResult> {
  const r = await call("/purchase", { name: input.name, email: input.email, phone: input.phone, planId: input.planId, paymentId: input.providerPaymentId });
  if (!r.ok) {
    return { ok: false, error: r.status === 0 ? "We could not reach the server." : (r.data?.message ?? "We could not save your enrollment.") };
  }
  if (r.data?.bundle) {
    applyBundle(r.data.bundle as Bundle);
    runOnboarding((r.data.bundle as Bundle).student, input.planId);
  }
  return { ok: true, loggedIn: !!r.data?.loggedIn };
}

export function recordFailedPayment(meta: Record<string, unknown>) { logEvent("payment_failed", meta); }

export async function recordUpgrade(studentId: string, _amount: number, providerPaymentId?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await call("/upgrade", { paymentId: providerPaymentId });
  if (!r.ok) return { ok: false, error: r.status === 0 ? "We could not reach the server." : (r.data?.message ?? "We could not save your upgrade.") };
  applyBundle(r.data.bundle as Bundle);
  const s = read().students.find((x) => x.id === studentId);
  if (s) sendWhatsAppInvite(s);
  return { ok: true };
}

/* ---------- Onboarding hooks (TODO: move to server) ---------- */
function runOnboarding(student: Student, planId: PlanId) {
  sendWelcomeEmail(student, planId);
  if (getPlan(planId)?.whatsapp) sendWhatsAppInvite(student);
}
export function sendWelcomeEmail(student: Student, planId: PlanId) {
  // TODO: call email provider from a server function.
  console.info("[TODO] welcome email →", student.email, planId);
}
export function sendWhatsAppInvite(student: Student) {
  // TODO: WhatsApp Business API invite from a server function.
  console.info("[TODO] WhatsApp invite →", student.phone, siteConfig.whatsappGroupUrl);
}
export function notifyAishwaryaOfSubmission(student: Student, assignmentId: string) {
  // TODO: send email to Aishwarya from a server function.
  console.info("[TODO] notify Aishwarya: new submission", student.email, assignmentId);
}

/* ---------- Watch progress ---------- */
export function getWatchProgress(studentId: string) { return read().watch.filter((w) => w.studentId === studentId); }
export function saveWatchProgress(studentId: string, sessionId: number, seconds: number[], duration: number) {
  const db = read();
  let w = db.watch.find((x) => x.studentId === studentId && x.sessionId === sessionId);
  if (!w) { w = { studentId, sessionId, watchedSeconds: [], duration, updatedAt: now() }; db.watch.push(w); }
  w.watchedSeconds = Array.from(new Set([...w.watchedSeconds, ...seconds])).sort((a, b) => a - b);
  w.duration = duration; w.updatedAt = now();
  write(db);
  void pushSync(studentId);
  return w;
}
export function markSessionWatched(studentId: string, sessionId: number) { logEvent("session_watched", { sessionId }, studentId); }

/* ---------- Assignments ---------- */
export function getSubmissions(studentId: string) { return read().submissions.filter((s) => s.studentId === studentId); }
export function submitAssignment(student: Student, assignmentId: string, data: { text?: string | undefined; fileName?: string | undefined }) {
  const db = read();
  db.submissions = db.submissions.filter((s) => !(s.studentId === student.id && s.assignmentId === assignmentId));
  db.submissions.push({ id: uid(), studentId: student.id, assignmentId, ...data, status: "Submitted", createdAt: now() });
  db.events.push({ id: uid(), type: "assignment_submitted", studentId: student.id, meta: { assignmentId }, at: now() });
  write(db);
  void pushSync(student.id, true);
  notifyAishwaryaOfSubmission(student, assignmentId);
}

/* ---------- Certificates ---------- */
export function issueCertificate(studentId: string, planId: PlanId) {
  const db = read();
  let c = db.certificates.find((x) => x.studentId === studentId);
  if (!c) { c = { id: uid(), studentId, planId, issuedAt: now() }; db.certificates.push(c); write(db); void pushSync(studentId, true); }
  return c;
}

export function updateProfile(studentId: string, patch: Partial<Pick<Student, "name" | "phone">>) {
  const db = read();
  const s = db.students.find((x) => x.id === studentId);
  if (s) Object.assign(s, patch);
  write(db);
  void pushSync(studentId, true);
  return s;
}

/** Export everything for the Client Dashboard / debugging. */
export function exportAll() { return read(); }
export type { Payment };
