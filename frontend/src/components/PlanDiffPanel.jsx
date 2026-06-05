import React from 'react';

/**
 * Renders a Terraform plan diff table.
 *
 * Props:
 *   planDiff — { summary: {add, change, destroy}, resource_changes: [...] }
 */
const ACTION_META = {
  create:  { label: 'Add',     className: 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300',  badge: 'bg-green-500' },
  update:  { label: 'Change',  className: 'bg-yellow-50 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300', badge: 'bg-yellow-500' },
  delete:  { label: 'Destroy', className: 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300',   badge: 'bg-red-500' },
  no_op:   { label: 'No-op',   className: 'bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-400',  badge: 'bg-gray-400' },
  replace: { label: 'Replace', className: 'bg-orange-50 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300', badge: 'bg-orange-500' },
};

function getActionMeta(actions) {
  if (!actions || actions.length === 0) return ACTION_META.no_op;
  if (actions.includes('delete') && actions.includes('create')) return ACTION_META.replace;
  return ACTION_META[actions[0]] || ACTION_META.no_op;
}

export default function PlanDiffPanel({ planDiff }) {
  if (!planDiff) return null;

  const { summary = {}, resource_changes = [] } = planDiff;
  const visible = resource_changes.filter(rc => {
    const a = rc.change?.actions || [];
    return !(a.length === 1 && a[0] === 'no-op');
  });

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      {/* Summary bar */}
      <div className="flex items-center gap-4 px-4 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Plan Summary</span>
        <SummaryChip count={summary.add    || 0} label="to add"     color="text-green-600 dark:text-green-400" />
        <SummaryChip count={summary.change || 0} label="to change"  color="text-yellow-600 dark:text-yellow-400" />
        <SummaryChip count={summary.destroy|| 0} label="to destroy" color="text-red-600 dark:text-red-400" />
      </div>

      {visible.length === 0 ? (
        <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">No resource changes detected.</p>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {visible.map((rc, i) => {
            const meta = getActionMeta(rc.change?.actions);
            return (
              <div key={i} className={`flex items-center justify-between px-4 py-2 text-xs ${meta.className}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${meta.badge}`} />
                  <span className="font-mono truncate">{rc.type}.{rc.name}</span>
                </div>
                <span className="flex-shrink-0 ml-4 font-semibold">{meta.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SummaryChip({ count, label, color }) {
  return (
    <span className={`text-xs font-medium ${count > 0 ? color : 'text-gray-400 dark:text-gray-500'}`}>
      {count} {label}
    </span>
  );
}
