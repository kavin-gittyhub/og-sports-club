import { useMemo, useState, useRef, useEffect } from 'react';
import { Icon } from './Icons.jsx';
import { addDays, dayNum, weekdayShort, monthShort, dayOfWeek } from '../lib/format.js';

/** Horizontal, thumb-friendly strip of upcoming dates. */
export function DateStrip({ today, value, onChange, days = 14, maxDate }) {
  const ref = useRef(null);
  const dates = useMemo(() => {
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(today, i);
      if (maxDate && d > maxDate) break;
      out.push(d);
    }
    return out;
  }, [today, days, maxDate]);
  useEffect(() => {
    ref.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [value]);
  return (
    <div className="date-strip" ref={ref} role="group" aria-label="Choose a date">
      {dates.map((d, i) => (
        <button
          key={d}
          type="button"
          className={`date-chip ${value === d ? 'is-selected' : ''} ${[0, 6].includes(dayOfWeek(d)) ? 'is-weekend' : ''}`}
          aria-pressed={value === d}
          onClick={() => onChange(d)}
        >
          <span className="date-chip-dow">{i === 0 ? 'Today' : i === 1 ? 'Tmrw' : weekdayShort(d)}</span>
          <span className="date-chip-day">{dayNum(d)}</span>
          <span className="date-chip-mon">{monthShort(d)}</span>
        </button>
      ))}
    </div>
  );
}

/** Month grid date picker. */
export function MonthCalendar({ today, value, onChange, minDate, maxDate }) {
  const [cursor, setCursor] = useState(() => (value || today).slice(0, 7) + '-01');
  const cells = useMemo(() => {
    const first = cursor;
    const lead = dayOfWeek(first);
    const out = [];
    for (let i = 0; i < lead; i++) out.push(null);
    let d = first;
    while (d.slice(0, 7) === cursor.slice(0, 7)) {
      out.push(d);
      d = addDays(d, 1);
    }
    return out;
  }, [cursor]);
  const monthLabel = new Date(cursor + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const shiftMonth = (n) => {
    const [y, m] = cursor.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1 + n, 1));
    setCursor(dt.toISOString().slice(0, 10));
  };
  const canPrev = !minDate || cursor > minDate.slice(0, 7) + '-01';
  const canNext = !maxDate || cursor.slice(0, 7) < maxDate.slice(0, 7);
  return (
    <div className="month-cal">
      <div className="month-cal-head">
        <button type="button" className="icon-btn" onClick={() => shiftMonth(-1)} disabled={!canPrev} aria-label="Previous month"><Icon name="chevronLeft" /></button>
        <strong>{monthLabel}</strong>
        <button type="button" className="icon-btn" onClick={() => shiftMonth(1)} disabled={!canNext} aria-label="Next month"><Icon name="chevronRight" /></button>
      </div>
      <div className="month-cal-grid" role="grid">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x, i) => <span key={i} className="month-cal-dow">{x}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />;
          const disabled = (minDate && d < minDate) || (maxDate && d > maxDate);
          return (
            <button
              key={d}
              type="button"
              disabled={disabled}
              className={`month-cal-day ${d === value ? 'is-selected' : ''} ${d === today ? 'is-today' : ''}`}
              onClick={() => onChange(d)}
              aria-pressed={d === value}
              aria-label={d}
            >
              {dayNum(d)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
