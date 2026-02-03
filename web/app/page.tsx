export default function Home() {
  return (
    <main>
      <header className="section hero">
        <div className="container hero-grid">
          <div className="fade-up">
            <p className="kicker muted">Agentic Edge Fund</p>
            <h1>Autonomous trading with hedge fund discipline.</h1>
            <p className="muted" style={{ marginTop: "1.2rem", maxWidth: 560 }}>
              Serious Trader Ralph is an agentic edge fund system that observes
              markets, decides with policy-driven risk control, and executes
              on-chain without hesitation. Built to stay focused, deliberate,
              and always on.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="#contact">
                Request access
              </a>
              <a className="button secondary" href="#thesis">
                Read the thesis
              </a>
            </div>
            <div className="badges">
              <span className="badge">Autonomous</span>
              <span className="badge">On-Chain</span>
              <span className="badge">Policy-Bound</span>
            </div>
          </div>
          <div className="hero-card fade-up delay-2">
            <h3>Fund profile</h3>
            <p className="muted">
              Ralph is designed as a compact hedge fund engine focused on Solana.
              It prioritizes discipline, continuous attention, and fast on-chain
              execution.
            </p>
            <div style={{ marginTop: "1.5rem" }} className="grid-3">
              <div>
                <p className="label">Mandate</p>
              <p>Agentic edge fund</p>
              </div>
              <div>
                <p className="label">Execution</p>
                <p>Spot, perps, prediction markets</p>
              </div>
              <div>
                <p className="label">Governance</p>
                <p>Human override, strict guardrails</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="section" id="thesis">
        <div className="container">
          <h2 className="fade-up">A hedge fund mind, an agentic body.</h2>
          <p className="muted" style={{ marginTop: "1rem", maxWidth: 680 }}>
            The thesis is simple: markets move fast, and a hedge fund needs
            relentless attention. Ralph stays active, researches constantly, and
            executes when the signal is clear—without drama, without noise.
          </p>
          <div className="grid-3" style={{ marginTop: "2rem" }}>
            <div className="card fade-up delay-1">
              <p className="label">Discipline</p>
              <h3>Risk first.</h3>
              <p className="muted">
                Every action is filtered by policy. Position sizing, exposure,
                and trade selection are always bounded.
              </p>
            </div>
            <div className="card fade-up delay-2">
              <p className="label">Autonomy</p>
              <h3>Always on.</h3>
              <p className="muted">
                The agent watches, evaluates, and acts on-chain in real time—day
                or night.
              </p>
            </div>
            <div className="card fade-up delay-3">
              <p className="label">Clarity</p>
              <h3>Simple thesis.</h3>
                <p className="muted">
                  No overfit complexity. Clear signals, clean execution, and a
                  narrow focus on edge.
                </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="grid-3">
            <div className="card">
              <p className="label">Agentic loop</p>
              <h3>Observe → Decide → Execute.</h3>
              <p className="muted">
                Ralph follows a tight loop that mirrors a hedge fund desk—monitor,
                propose, validate, and act.
              </p>
            </div>
            <div className="card">
              <p className="label">Trade surfaces</p>
              <h3>On-chain breadth.</h3>
              <p className="muted">
                Focused on the edges that matter, with the flexibility to access
                spot swaps, perps, and prediction markets when signals appear.
              </p>
            </div>
            <div className="card">
              <p className="label">Control</p>
              <h3>Guardrails built in.</h3>
              <p className="muted">
                Policies define exposure, slippage, and execution boundaries—no
                surprises, no improvisation.
              </p>
            </div>
          </div>
          <div className="stat-row" style={{ marginTop: "2rem" }}>
            <div className="stat">
              <strong>24/7</strong>
              <span className="muted">Market attention</span>
            </div>
            <div className="stat">
              <strong>On-chain</strong>
              <span className="muted">Execution by design</span>
            </div>
            <div className="stat">
              <strong>Policy</strong>
              <span className="muted">Bound autonomy</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2>How it shows up.</h2>
          <div className="timeline" style={{ marginTop: "1.8rem" }}>
            <div className="timeline-item">
              <span className="timeline-dot" aria-hidden="true" />
              <div>
                <h3>Relentless research</h3>
                <p className="muted">
                  The agent stays busy with focused research, scanning for
                  asymmetric opportunities and avoiding noise.
                </p>
              </div>
            </div>
            <div className="timeline-item">
              <span className="timeline-dot" aria-hidden="true" />
              <div>
                <h3>Signal discipline</h3>
                <p className="muted">
                  Trades happen only when the signal is clear and the risk budget
                  allows it.
                </p>
              </div>
            </div>
            <div className="timeline-item">
              <span className="timeline-dot" aria-hidden="true" />
              <div>
                <h3>Autonomous execution</h3>
                <p className="muted">
                  On-chain actions are executed swiftly, then monitored for
                  follow-through or exit.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="contact">
        <div className="container">
          <div className="callout">
            <h2>Build with Ralph.</h2>
            <p className="muted">
              We are assembling a focused group of partners who want an agentic
              edge fund system that executes on-chain with discipline.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="mailto:hello@ralph.fund">
                Start a conversation
              </a>
            </div>
            <p className="muted" style={{ marginTop: "0.75rem" }}>
              Not investment advice.
            </p>
          </div>
        </div>
      </section>

      <footer className="footer">
        <div className="container">
          <p className="muted">
            Serious Trader Ralph — agentic edge fund system.
          </p>
        </div>
      </footer>
    </main>
  );
}
