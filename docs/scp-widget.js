(() => {
  const mount = document.getElementById('scpReactWidget');
  if (!mount || !window.React || !window.ReactDOM || !window.htm) {
    return;
  }

  const { useEffect, useState, Fragment } = window.React;
  const html = window.htm.bind(window.React.createElement);

  const NODES = [
    { id: 'apex', x: 160, y: 62, r: 4, tier: 0 },
    { id: 'tl', x: 108, y: 98, r: 2.4, tier: 1 },
    { id: 'tr', x: 212, y: 98, r: 2.4, tier: 1 },
    { id: 'ml', x: 88, y: 148, r: 2, tier: 2 },
    { id: 'mr', x: 232, y: 148, r: 2, tier: 2 },
    { id: 'bl', x: 108, y: 192, r: 2.2, tier: 1 },
    { id: 'br', x: 212, y: 192, r: 2.2, tier: 1 },
    { id: 'waist', x: 160, y: 192, r: 1.6, tier: 3 },
    { id: 'tip', x: 160, y: 318, r: 3, tier: 0 }
  ];

  const EDGES = [
    ['apex', 'tl', 1],
    ['apex', 'tr', 1],
    ['tl', 'ml', 0.9],
    ['tr', 'mr', 0.9],
    ['ml', 'bl', 0.8],
    ['mr', 'br', 0.8],
    ['tl', 'tr', 0.5],
    ['ml', 'mr', 0.4],
    ['bl', 'br', 0.7],
    ['bl', 'waist', 0.5],
    ['br', 'waist', 0.5],
    ['bl', 'tip', 1],
    ['br', 'tip', 1],
    ['waist', 'tip', 0.6],
    ['bl', 'mr', 0.2],
    ['br', 'ml', 0.2]
  ];

  const AMBIENT = [
    [28, 44, 0.8, 3.8],
    [292, 30, 0.7, 4.5],
    [14, 180, 0.6, 5.2],
    [306, 155, 0.9, 3.2],
    [38, 300, 0.7, 6],
    [288, 290, 0.6, 4.1],
    [55, 355, 0.5, 5.5],
    [265, 360, 0.6, 3.7],
    [74, 82, 0.5, 4.8],
    [246, 88, 0.7, 5],
    [160, 28, 0.5, 6.2]
  ];

  function getNode(id) {
    return NODES.find(node => node.id === id);
  }

  function edgeLength(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function Widget() {
    const [drawn, setDrawn] = useState([]);
    const [nodesVisible, setNodesVisible] = useState([]);
    const [cherryReady, setCherryReady] = useState(false);

    useEffect(() => {
      const timers = [];

      EDGES.forEach((_, index) => {
        timers.push(window.setTimeout(() => {
          setDrawn(current => current.includes(index) ? current : [...current, index]);
        }, 180 + index * 85));
      });

      NODES.forEach((node, index) => {
        timers.push(window.setTimeout(() => {
          setNodesVisible(current => current.includes(node.id) ? current : [...current, node.id]);
        }, 210 + index * 70));
      });

      timers.push(window.setTimeout(() => {
        setCherryReady(true);
      }, 180 + EDGES.length * 85 + 260));

      return () => timers.forEach(timer => window.clearTimeout(timer));
    }, []);

    return html`
      <div style=${{
        minHeight: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '18px 8px',
        background: 'transparent'
      }}>
        <style>
          ${`
            @keyframes scpTwink {
              0%, 100% { opacity: var(--op); }
              50% { opacity: calc(var(--op) * 0.15); }
            }
            @keyframes scpBreathe {
              0%, 100% { r: 22; opacity: 0.06; }
              50% { r: 28; opacity: 0.03; }
            }
            @keyframes scpBreathe2 {
              0%, 100% { r: 13; opacity: 0.1; }
              50% { r: 17; opacity: 0.05; }
            }
            @keyframes scpNodePop {
              0% { transform: scale(0); opacity: 0; }
              60% { transform: scale(1.35); opacity: 1; }
              100% { transform: scale(1); opacity: 1; }
            }
            @keyframes scpCherryPulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.55; }
            }
            @keyframes scpFadeUp {
              from { opacity: 0; transform: translateY(6px); }
              to { opacity: 1; transform: translateY(0); }
            }
          `}
        </style>
        <svg
          width="320"
          height="420"
          viewBox="0 0 320 420"
          style=${{ overflow: 'visible', width: 'min(100%, 320px)', height: 'auto' }}
        >
          <defs>
            <filter id="scpWidgetGlow">
              <feGaussianBlur stdDeviation="3.5" result="b"></feGaussianBlur>
              <feMerge>
                <feMergeNode in="b"></feMergeNode>
                <feMergeNode in="SourceGraphic"></feMergeNode>
              </feMerge>
            </filter>
            <filter id="scpWidgetBigGlow">
              <feGaussianBlur stdDeviation="9" result="b"></feGaussianBlur>
              <feMerge>
                <feMergeNode in="b"></feMergeNode>
                <feMergeNode in="SourceGraphic"></feMergeNode>
              </feMerge>
            </filter>
          </defs>

          ${AMBIENT.map(([x, y, r, duration], index) => html`
            <circle
              key=${'ambient-' + index}
              cx=${x}
              cy=${y}
              r=${r}
              fill="white"
              style=${{
                '--op': 0.28,
                animation: `scpTwink ${duration}s ease-in-out ${index * 0.37}s infinite`
              }}
            />
          `)}

          ${EDGES.map(([from, to, opacity], index) => {
            const a = getNode(from);
            const b = getNode(to);
            const len = edgeLength(a, b);
            const show = drawn.includes(index);
            return html`
              <line
                key=${'edge-' + index}
                x1=${a.x}
                y1=${a.y}
                x2=${b.x}
                y2=${b.y}
                stroke=${`rgba(255,255,255,${(opacity * 0.22).toFixed(2)})`}
                strokeWidth=${opacity > 0.7 ? 1 : 0.7}
                strokeLinecap="round"
                strokeDasharray=${len}
                strokeDashoffset=${show ? 0 : len}
                style=${{
                  transition: show ? 'stroke-dashoffset 0.55s cubic-bezier(0.4,0,0.2,1)' : 'none'
                }}
              />
            `;
          })}

          ${NODES.filter(node => node.id !== 'apex').map(node => {
            const show = nodesVisible.includes(node.id);
            return html`
              <circle
                key=${node.id}
                cx=${node.x}
                cy=${node.y}
                r=${node.r}
                fill="white"
                filter=${node.tier === 0 ? 'url(#scpWidgetGlow)' : undefined}
                style=${{
                  transformOrigin: `${node.x}px ${node.y}px`,
                  animation: show ? 'scpNodePop 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards' : 'none',
                  opacity: show ? 1 : 0
                }}
              />
            `;
          })}

          ${cherryReady ? html`
            <${Fragment}>
              <circle
                cx="160"
                cy="62"
                r="22"
                fill="white"
                style=${{ animation: 'scpBreathe 3s ease-in-out infinite' }}
              />
              <circle
                cx="160"
                cy="62"
                r="13"
                fill="white"
                style=${{ animation: 'scpBreathe2 3s ease-in-out 0.5s infinite' }}
              />
              ${[[160, 44, 160, 80], [142, 62, 178, 62]].map((line, index) => html`
                <line
                  key=${'ray-main-' + index}
                  x1=${line[0]}
                  y1=${line[1]}
                  x2=${line[2]}
                  y2=${line[3]}
                  stroke="rgba(255,255,255,0.55)"
                  strokeWidth="0.9"
                  strokeLinecap="round"
                />
              `)}
              ${[[149, 51, 171, 73], [171, 51, 149, 73]].map((line, index) => html`
                <line
                  key=${'ray-diag-' + index}
                  x1=${line[0]}
                  y1=${line[1]}
                  x2=${line[2]}
                  y2=${line[3]}
                  stroke="rgba(255,255,255,0.25)"
                  strokeWidth="0.7"
                  strokeLinecap="round"
                />
              `)}
            </${Fragment}>
          ` : null}

          <circle
            cx="160"
            cy="62"
            r="4"
            fill="white"
            filter="url(#scpWidgetBigGlow)"
            style=${{
              transformOrigin: '160px 62px',
              opacity: nodesVisible.includes('apex') ? 1 : 0,
              animation: cherryReady ? 'scpCherryPulse 3s ease-in-out infinite' : 'none',
              transition: 'opacity 0.5s ease'
            }}
          />

          <g
            style=${{
              opacity: cherryReady ? 1 : 0,
              animation: cherryReady ? 'scpFadeUp 1s ease forwards' : 'none'
            }}
          >
            <line x1="118" y1="360" x2="202" y2="360" stroke="rgba(255,255,255,0.12)" strokeWidth="0.6" />
            <text
              x="160"
              y="380"
              textAnchor="middle"
              fontFamily="'Futura','Century Gothic','Trebuchet MS',sans-serif"
              fontSize="9"
              letterSpacing="7"
              fill="rgba(255,255,255,0.35)"
              fontWeight="300"
            >SCP</text>
            <line x1="118" y1="394" x2="202" y2="394" stroke="rgba(255,255,255,0.12)" strokeWidth="0.6" />
          </g>
        </svg>
      </div>
    `;
  }

  const root = window.ReactDOM.createRoot
    ? window.ReactDOM.createRoot(mount)
    : { render: node => window.ReactDOM.render(node, mount) };

  root.render(html`<${Widget} />`);
})();
