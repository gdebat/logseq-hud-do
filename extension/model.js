export const statuses = ['TODO', 'DOING'];
export const sections = ['today', 'overdue', 'upcoming'];
export const priorities = {A: ['High', 'high'], B: ['Medium', 'medium'], C: ['Low', 'low']};

export function backendArguments(directory, graphs, horizon) {
    if (!graphs.length)
        throw new Error('Add a Logseq graph in Preferences.');
    const args = ['python3', '-m', 'logseq_hud_do', '--horizon', String(horizon)];
    for (const [path, name] of graphs) {
        if (!path.startsWith('/'))
            throw new Error('Graph directories must be absolute paths.');
        args.push(`--graph=${path}`, `--graph-name=${name || path.split('/').filter(Boolean).pop()}`);
    }
    return {args, directory};
}

export function parseTasks(stdout) {
    const data = JSON.parse(stdout);
    for (const section of sections) {
        if (!Array.isArray(data[section]))
            throw new Error('Invalid backend response.');
        for (const task of data[section]) {
            if (typeof task.content !== 'string' || typeof task.graph !== 'string' ||
                typeof task.source_page !== 'string' ||
                !statuses.includes(task.status) ||
                (task.priority !== null && !Object.hasOwn(priorities, task.priority)) ||
                (task.scheduled !== null && typeof task.scheduled !== 'string') ||
                (task.deep_link !== null && typeof task.deep_link !== 'string'))
                throw new Error('Invalid backend task.');
        }
    }
    return data;
}

export function taskPresentation(task) {
    return {
        content: task.content.replace(/\[#(?:A|B|C)\][ \t]*/g, '').trim(),
        doing: task.status === 'DOING',
        priority: priorities[task.priority] ?? null,
        context: `${task.graph} · ${task.scheduled || task.source_page}`,
        uri: typeof task.deep_link === 'string' && task.deep_link.startsWith('logseq://graph/')
            ? task.deep_link : null,
    };
}

// A settings change during a scan must get a fresh scan after that process exits.
export class RefreshController {
    constructor(run, publish, fail) {
        this.run = run;
        this.publish = publish;
        this.fail = fail;
        this.active = false;
        this.pending = false;
        this.closed = false;
    }

    async refresh(invalidate = false) {
        if (this.closed)
            return;
        if (this.active) {
            this.pending = true;
            this.obsolete ||= invalidate;
            return;
        }
        this.active = true;
        this.obsolete = false;
        try {
            const data = await this.run();
            if (!this.closed && !this.obsolete)
                this.publish(data);
        } catch (error) {
            if (!this.closed && !this.obsolete)
                this.fail(error.message);
        } finally {
            this.active = false;
            if (this.pending && !this.closed) {
                this.pending = false;
                this.refresh();
            }
        }
    }

    close() {
        this.closed = true;
        this.pending = false;
    }
}
