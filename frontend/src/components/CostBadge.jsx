import React from 'react';

/**
 * CostBadge — displays monthly cost estimate.
 *
 * Props:
 *   total   — number (monthly USD) or null
 *   items   — [{ resource, monthly_usd }]
 *   engine  — 'infracost' | 'static'
 */
export default function CostBadge({ total, items = [], engine }) {
  if (total === undefined || total === null) return null;

  const isUsageBased = total === 0 && items.length === 0;
  const fmt = (n) => n === 0 ? 'Free / usage-based' : `~$${Number(n).toFixed(2)}/mo`;

  return (
    <div className="inline-flex flex-col gap-1">
      {/* Main badge */}
      <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${
        total === 0
          ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
          : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
      }`}>
        <span>💰</span>
        <span>{isUsageBased ? 'Free / usage-based' : fmt(total)}</span>
        {engine === 'static' && (
          <span className="text-[10px] font-normal opacity-70">(est.)</span>
        )}
      </span>

      {/* Per-resource breakdown (collapsible via details) */}
      {items.length > 1 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 select-none">
            {items.length} resources breakdown
          </summary>
          <ul className="mt-1 space-y-0.5 pl-2">
            {items.map((item, i) => (
              <li key={i} className="flex justify-between gap-4 text-gray-600 dark:text-gray-400">
                <span className="font-mono truncate max-w-[200px]">{item.resource}</span>
                <span className="flex-shrink-0">{fmt(item.monthly_usd)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
