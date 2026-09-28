import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

// Colour run taken from the reference wheel, repeated around the rim
export const PALETTE = [
  '#6b0f1a', '#c4170c', '#a35d00', '#b3a600', '#2e8a2b', '#0b5d4b',
  '#0a8db0', '#0b5ab4', '#2b2a8f', '#6e0a78', '#b2103b', '#3c3440',
];

const SIZE = 1000;
const C = SIZE / 2;
const R_OUTER = 490;
const R_SEG = 462;
const R_HUB = 82;
const SPIN_SPEED = 0.75; // degrees per ms at full speed

const polar = (r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
};

const slicePath = (r0, r1, a0, a1) => {
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0},${y0} A${r1},${r1} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${large} 0 ${x3},${y3} Z`;
};

const mod = (n, m) => ((n % m) + m) % m;

/**
 * Spinning prize wheel. Parent calls ref.start() when the draw request goes out,
 * then ref.landOn(index) once the winner is known; onSettle fires when it stops.
 */
const Wheel = forwardRef(function Wheel({ labels, highlight, onTick, onSettle, format = (x) => x }, ref) {
  const n = labels.length;
  const seg = 360 / n;
  const groupRef = useRef(null);
  const anim = useRef({ angle: 0, velocity: 0, phase: 'idle', raf: 0 });
  const lastIndex = useRef(-1);
  const [spinning, setSpinning] = useState(false);

  const indexAtPointer = (angle) => mod(Math.floor(mod(-angle, 360) / seg), n);

  const apply = (angle) => {
    if (groupRef.current) groupRef.current.setAttribute('transform', `rotate(${angle} ${C} ${C})`);
    const i = indexAtPointer(angle);
    if (i !== lastIndex.current) {
      lastIndex.current = i;
      onTick?.(i);
    }
  };

  useEffect(() => () => cancelAnimationFrame(anim.current.raf), []);
  useEffect(() => apply(anim.current.angle), [n]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    // Spin up to full speed and keep going until landOn() is called
    start() {
      const a = anim.current;
      cancelAnimationFrame(a.raf);
      a.phase = 'spinning';
      setSpinning(true);
      let last = performance.now();
      const step = (now) => {
        const dt = Math.min(now - last, 50);
        last = now;
        if (a.phase !== 'spinning') return;
        a.velocity = Math.min(SPIN_SPEED, a.velocity + dt * 0.0006);
        a.angle += a.velocity * dt;
        apply(a.angle);
        a.raf = requestAnimationFrame(step);
      };
      a.raf = requestAnimationFrame(step);
    },

    // Decelerate smoothly so segment `index` finishes under the pointer
    landOn(index) {
      const a = anim.current;
      cancelAnimationFrame(a.raf);
      a.phase = 'landing';
      const v = Math.max(a.velocity, 0.2);
      const jitter = (Math.random() - 0.5) * seg * 0.6;
      const target = -(index + 0.5) * seg + jitter;
      const extra = mod(target - a.angle, 360);
      const distance = 360 * 4 + extra;
      // easeOutCubic starts at 3x average speed, so match the current velocity
      const duration = (3 * distance) / v;
      const from = a.angle;
      const t0 = performance.now();
      const step = (now) => {
        const t = Math.min((now - t0) / duration, 1);
        a.angle = from + distance * (1 - Math.pow(1 - t, 3));
        apply(a.angle);
        if (t < 1) {
          a.raf = requestAnimationFrame(step);
        } else {
          a.phase = 'idle';
          a.velocity = 0;
          a.angle = mod(a.angle, 360);
          setSpinning(false);
          onSettle?.(index);
        }
      };
      a.raf = requestAnimationFrame(step);
    },

    // Stop without a result (e.g. the API call failed)
    stop() {
      const a = anim.current;
      cancelAnimationFrame(a.raf);
      const v0 = a.velocity;
      const from = a.angle;
      const duration = Math.max(600, (3 * 360) / Math.max(v0, 0.2));
      const t0 = performance.now();
      a.phase = 'stopping';
      const step = (now) => {
        const t = Math.min((now - t0) / duration, 1);
        a.angle = from + ((v0 * duration) / 3) * (1 - Math.pow(1 - t, 3));
        apply(a.angle);
        if (t < 1) a.raf = requestAnimationFrame(step);
        else {
          a.phase = 'idle';
          a.velocity = 0;
          setSpinning(false);
        }
      };
      a.raf = requestAnimationFrame(step);
    },
  }));

  const labelSize = n > 90 ? 11 : n > 60 ? 15 : n > 36 ? 19 : 24;

  const slices = useMemo(
    () =>
      labels.map((label, i) => {
        const a0 = i * seg;
        const a1 = a0 + seg;
        const mid = a0 + seg / 2;
        const color = PALETTE[i % PALETTE.length];
        const [tx, ty] = polar(R_SEG - 16, mid);
        return { i, a0, a1, mid, color, tx, ty, label };
      }),
    [labels, seg]
  );

  return (
    <svg className={`wheel ${spinning ? 'is-spinning' : ''}`} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Prize wheel">
      <defs>
        <radialGradient id="shade" cx="50%" cy="50%" r="50%">
          <stop offset="55%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.18" />
        </radialGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g ref={groupRef}>
        {/* Translucent rim, same colour run as the segments */}
        {slices.map((s) => (
          <path key={`rim${s.i}`} d={slicePath(R_SEG, R_OUTER, s.a0, s.a1 + 0.2)} fill={s.color} opacity="0.45" />
        ))}
        {slices.map((s) => (
          <path
            key={`seg${s.i}`}
            d={slicePath(0, R_SEG, s.a0, s.a1 + 0.2)}
            fill={s.color}
            className={highlight == null ? '' : highlight === s.i ? 'seg-win' : 'seg-dim'}
          />
        ))}
        <circle cx={C} cy={C} r={R_SEG} fill="url(#shade)" pointerEvents="none" />
        {slices.map((s) => (
          <text
            key={`t${s.i}`}
            x={s.tx}
            y={s.ty}
            transform={`rotate(${s.mid - 90} ${s.tx} ${s.ty})`}
            textAnchor="end"
            dominantBaseline="central"
            className="seg-label"
            fontSize={labelSize}
            opacity={highlight == null || highlight === s.i ? 1 : 0.35}
          >
            {format(s.label)}
          </text>
        ))}
        {highlight != null && slices[highlight] && (
          <path
            d={slicePath(R_HUB, R_OUTER, slices[highlight].a0, slices[highlight].a1)}
            fill="none"
            stroke="#fff"
            strokeWidth="5"
            filter="url(#glow)"
          />
        )}
      </g>

      {/* Fixed hub with the teardrop pointer, as on the reference wheel */}
      <g className="hub">
        <path
          d={`M${C},${C - R_HUB - 58} C${C + 14},${C - R_HUB - 30} ${C + 40},${C - R_HUB + 6} ${C + R_HUB * 0.62},${C - R_HUB * 0.78}
              A${R_HUB},${R_HUB} 0 1 1 ${C - R_HUB * 0.62},${C - R_HUB * 0.78}
              C${C - 40},${C - R_HUB + 6} ${C - 14},${C - R_HUB - 30} ${C},${C - R_HUB - 58} Z`}
          fill="#000"
          stroke="#fff"
          strokeWidth="9"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
});

export default Wheel;
