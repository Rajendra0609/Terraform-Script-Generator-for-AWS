import React, { useState } from 'react';

/**
 * Renders Checkov / static security scan findings with severity badges.
 *
 * Props:
 *   findings  — array of { check_id, resource, severity, message, guideline_url }
 *   passed    — number of passed checks
 *   failed    — number of failed checks
 */
const SEV_META = {
  CRITICAL: { label: 'CRITICAL', cls: 'bg-red-600 text-white' },
  HIGH:     { label: 'HIGH',     cls: 'bg-orange-500 text-white' },
  MEDIUM:   { label: 'MEDIUM',   cls: 'bg-yellow-500 text-black' },
  LOW:      { label: 'LOW',      cls: 'bg-blue-500 text-white' },
  INFO:     { label: 'INFO',     cls: 'bg-gray-400 text-white' },
};

function SeverityBadge({ severity }) {
  const meta = SEV_META[severity?.toUpperCase()] || SEV_META.INFO;
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

export default function SecurityFindings({ findings = [], passed = 0, failed = 0, engine }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-3">
          <span>Security Scan</span>
          {engine && <span className="text-[10px] font-normal text-gray-400">via {engine}</span>}
          <span className="text-green-600 dark:text-green-400">{passed} passed</span>
          {failed > 0 && <span className="text-red-600 dark:text-red-400">{failed} failed</span>}
        </div>
        <span className="text-gray-400">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {findings.length === 0 ? (
            <p className="px-4 py-3 text-sm text-green-600 dark:text-green-400">
              ✓ No security findings detected.
            </p>
          ) : (
            findings.map((f, i) => (
              <div key={i} className="px-4 py-2">
                <div className="flex items-start gap-2">
                  <SeverityBadge severity={f.severity} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-gray-500 dark:text-gray-400">{f.check_id}</span>
                      {f.resource && (
                        <span className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate">{f.resource}</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-700 dark:text-gray-300 mt-0.5">{f.message}</p>
                    {f.guideline_url && (
                      <a
                        href={f.guideline_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-blue-500 hover:underline mt-0.5 inline-block"
                      >
                        View guideline ↗
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
