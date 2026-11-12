// 仅本地契约测试使用的内存假数据库；复刻探针用到的 Supabase 风格子集。
// 支持排序与唯一约束模拟，但不证明真实 Provider 的权限、事务或并发行为；不要打进 Function 包。
export function createFakeDb(control = { writes: [] }, options = {}) {
  if (!Array.isArray(control.writes)) control.writes = [];
  const tables = new Map();
  const unique = options.unique ?? {};
  const wait = options.wait ?? null;
  const rows = (table) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  };
  const pick = (row, columns) => (columns === '*' || columns === null
    ? { ...row }
    : Object.fromEntries(columns.split(',').map((column) => [column.trim(), row[column.trim()]])));

  const violatesUnique = (table, candidate, ignore = null) => {
    for (const columns of unique[table] ?? []) {
      if (columns.some((column) => candidate[column] === undefined || candidate[column] === null)) continue;
      if (rows(table).some((row) => row !== ignore
        && columns.every((column) => row[column] === candidate[column]))) return true;
    }
    return false;
  };

  function builder(table, mode, values) {
    const filters = [];
    const ordering = [];
    let columns = '*';
    let maxRows = Infinity;
    let execution;

    const run = async () => {
      if (wait) await wait(table, mode);
      const list = rows(table);
      const match = (row) => filters.every(([key, value]) => row[key] === value);

      if (mode === 'read') {
        let data = list.filter(match);
        for (const [key, ascending] of [...ordering].reverse()) {
          data = [...data].sort((a, b) => {
            if (a[key] === b[key]) return 0;
            const order = a[key] < b[key] ? -1 : 1;
            return ascending ? order : -order;
          });
        }
        return { data: data.slice(0, maxRows).map((row) => pick(row, columns)), error: null };
      }

      control.writes.push(table);

      if (mode === 'insert') {
        const conflict = (values.onConflict ?? '').split(',').map((column) => column.trim()).filter(Boolean);
        if (conflict.length && list.some((row) => conflict.every((key) => row[key] === values.row[key]))) {
          return { data: [], error: null };
        }
        if (violatesUnique(table, values.row)) return { data: [], error: null };
        list.push({ ...values.row });
        return { data: [pick(values.row, columns)], error: null };
      }

      const matched = list.filter(match);
      const snapshot = matched.map((row) => ({ ...row }));
      for (const row of matched) Object.assign(row, values.row);
      if (matched.some((row) => violatesUnique(table, row, row))) {
        matched.forEach((row, index) => {
          for (const key of Object.keys(row)) delete row[key];
          Object.assign(row, snapshot[index]);
        });
        return { data: [], error: { code: 'unique_violation', status: 409 } };
      }
      return { data: matched.map((row) => pick(row, columns)), error: null };
    };

    const chain = {
      eq(key, value) { filters.push([key, value]); return chain; },
      order(key, { ascending = true } = {}) { ordering.push([key, ascending]); return chain; },
      limit(count) { maxRows = count; return chain; },
      select(names) { if (typeof names === 'string') columns = names; return chain; },
      then(resolve, reject) { execution ??= Promise.resolve().then(run); return execution.then(resolve, reject); },
    };
    return chain;
  }

  return {
    from(table) {
      return {
        select: (columns) => builder(table, 'read', null).select(columns),
        insertIfAbsent: (row, optionsArg) => builder(table, 'insert', { row, onConflict: optionsArg?.onConflict }),
        update: (row) => builder(table, 'update', { row }),
      };
    },
    dump: (table) => rows(table).map((row) => ({ ...row })),
  };
}
