import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

export default function WelcomeScreen({ onAction, onLoadingChange }) {
  const { user, appName, logoUrl } = useAuth();
  const [briefing, setBriefing] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    let cancelled = false;
    api.get('/chat/welcome')
      .then(res => { if (!cancelled) setBriefing(res.data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) { setLoading(false); onLoadingChange?.(false); } });
    return () => { cancelled = true; };
  }, [user]);

  const firstName = user?.name?.split(' ')[0] || 'there';
  const h = new Date().getHours();
  const timeGreeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const serverGreeting = briefing?.greeting;
  const greeting = (serverGreeting && serverGreeting.includes(firstName))
    ? serverGreeting : `${timeGreeting}, ${firstName}!`;

  const hasNote = briefing?.memoryNote;
  const hasWeather = briefing?.weather;
  const hasIntegration = briefing?.hasIntegration;
  const rawAiName = briefing?.aiName || '';
  const aiDisplayName = rawAiName ? rawAiName.charAt(0).toUpperCase() + rawAiName.slice(1) : (appName || 'TMC AI');
  const isNewUser = !hasNote && !hasWeather && !rawAiName;

  return (
    <div className="welcome-chat">
      <div className="message-row">
        <div className="message-inner">
          <div className="msg-avatar assistant">
            <img src={logoUrl} alt="" className="avatar-logo" />
          </div>
          <div className="msg-body">
            {!loading && <div className="msg-name">{aiDisplayName}</div>}
            <div className="msg-text welcome-text">
              {loading ? (
                <WelcomeLoader firstName={firstName} />
              ) : (
                <div className="welcome-flow">
                  <p>{greeting} {hasWeather && <span className="welcome-weather-inline">{briefing.weather}</span>}</p>
                  {hasNote && <p className="welcome-caring">{briefing.memoryNote}</p>}
                  {isNewUser ? (
                    <div className="welcome-intro">
                      <p>Hey {firstName}! I'm your personal AI assistant — think of me as a smart friend who knows everything about your work.</p>
                      <p style={{ marginTop: 6 }}>Before we start, <strong>give me a name!</strong> Just say something like <em>"I'll call you Siri"</em> or <em>"Your name is Jeni"</em> — I'll remember it forever.</p>
                      <p style={{ marginTop: 6, color: '#888', fontSize: 13 }}>Also tell me your city for weather updates, and connect your email & calendar in <strong>Settings</strong> so I can really help you out.</p>
                    </div>
                  ) : (
                    <>
                      {!hasWeather && hasNote && (
                        <p className="welcome-subtle">Tell me your city and I'll keep you updated on weather too!</p>
                      )}
                    </>
                  )}
                  {/* All action chips in one row */}
                  <div className="welcome-chips" style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    {isNewUser && (
                      <>
                        <button className="welcome-chip" onClick={() => onAction?.("My name is " + firstName + ", tell me what you can do for me")}>
                          What can you do?
                        </button>
                        <button className="welcome-chip" onClick={() => onAction?.("I'll call you Buddy")}>
                          Name the AI
                        </button>
                      </>
                    )}
                    <button className="welcome-chip" onClick={() => window.location.href = '/day-brief'}>
                      Day Brief ↗
                    </button>
                    {user?.isAdmin && briefing?.adminStats && (
                      <>
                        <button className="welcome-chip admin-chip" onClick={() => onAction?.('show me system logs and suggest fixes')}>
                          Logs ({briefing.adminStats.openLogs || 0}{briefing.adminStats.recurringLogs > 0 ? `, ${briefing.adminStats.recurringLogs} recurring` : ''})
                        </button>
                        <button className="welcome-chip admin-chip" onClick={() => onAction?.('show me token consumption report with cost breakdown and suggestions to reduce cost')}>
                          Tokens: {briefing.adminStats.mtdInputTokens}↑ {briefing.adminStats.mtdOutputTokens}↓ · ${briefing.adminStats.mtdCost}
                        </button>
                      </>
                    )}
                  </div>

                  {!isNewUser && !hasNote && <p className="welcome-closing">I'm all yours — what's on your mind?</p>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const LOADING_STEPS = [
  { text: 'Checking your calendar...', delay: 0 },
  { text: 'Reading your emails...', delay: 800 },
  { text: 'Fetching weather...', delay: 1600 },
  { text: 'Almost ready...', delay: 2800 },
];

function WelcomeLoader({ firstName }) {
  const [stepIdx, setStepIdx] = useState(0);
  const timers = useRef([]);

  useEffect(() => {
    LOADING_STEPS.forEach((step, i) => {
      if (i > 0) {
        const t = setTimeout(() => setStepIdx(i), step.delay);
        timers.current.push(t);
      }
    });
    return () => timers.current.forEach(t => clearTimeout(t));
  }, []);

  return (
    <div className="welcome-loading-state">
      <div className="welcome-loading-dots"><span></span><span></span><span></span></div>
      <p>{firstName}! Catching up on your world...</p>
      <p className="welcome-loading-step">{LOADING_STEPS[stepIdx].text}</p>
    </div>
  );
}
