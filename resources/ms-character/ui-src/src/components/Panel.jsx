export default function Panel({ title, subtitle, notice, children }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <main className="w-full max-w-xl border border-brass bg-ink p-10">
        <p className="font-sans text-xs tracking-[0.25em] text-gold">MAGICSCHOOL RP</p>
        <h1 className="my-5 text-3xl font-normal">{title}</h1>
        {subtitle && <p className="leading-relaxed" aria-live="polite">{subtitle}</p>}
        {children}
        <p role="alert" className="mt-4 min-h-6 text-ember">{notice}</p>
      </main>
    </div>
  );
}
