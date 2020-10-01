/**
 * Copyright (c) 2020 TypeFox GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { injectable, inject, postConstruct } from 'inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { GitpodTerminalWidget } from './gitpod-terminal-widget';
import { GitpodTaskState, GitpodTaskServer, GitpodTask } from '../common/gitpod-task-protocol';
import { IBaseTerminalServer } from '@theia/terminal/lib/common/base-terminal-protocol';

interface GitpodTaskTerminalWidget extends GitpodTerminalWidget {
    readonly kind: 'gitpod-task'
    remoteTerminal?: string
}
namespace GitpodTaskTerminalWidget {
    const idPrefix = 'gitpod-task-terminal'
    export function is(terminal: TerminalWidget): terminal is GitpodTaskTerminalWidget {
        return terminal.kind === 'gitpod-task';
    }
    export function toTerminalId(id: string): string {
        return idPrefix + ':' + id;
    }
    export function getTaskId(terminal: GitpodTaskTerminalWidget): string {
        return terminal.id.split(':')[1];
    }
}

@injectable()
export class GitpodTaskContribution implements FrontendApplicationContribution {

    @inject(TerminalFrontendContribution)
    private readonly terminals: TerminalFrontendContribution;

    @inject(GitpodTaskServer)
    private readonly server: GitpodTaskServer;

    private readonly taskTerminals = new Map<string, GitpodTaskTerminalWidget>();

    private pendingUpdates = Promise.resolve();

    @postConstruct()
    protected init(): void {
        this.terminals.onDidCreateTerminal(terminal => {
            if (GitpodTaskTerminalWidget.is(terminal)) {
                this.taskTerminals.set(terminal.id, terminal);
                terminal.onDidDispose(() =>
                    this.taskTerminals.delete(terminal.id)
                );
                terminal.onTerminalDidClose(() => {
                    if (terminal.remoteTerminal) {
                        fetch(window.location.protocol + '//' + window.location.host + '/_supervisor/v1/terminal/close/' + terminal.remoteTerminal)
                    } else {
                        console.error('task alias is missing');
                    }
                });
            }
        });
    }

    onDidInitializeLayout(): Promise<void> {
        this.pendingUpdates = this.initTerminals().catch(e => console.error('Failed to initizalize Gitpod task terminals:', e));
        this.server.setClient({
            onDidChange: tasks =>
                this.pendingUpdates = this.pendingUpdates.then(() => this.updateTerminals(tasks))
        });
        return this.pendingUpdates;
    }

    protected async initTerminals(): Promise<void> {
        const tasks = await this.server.getTasks();
        let ref: TerminalWidget | undefined;
        for (const task of tasks) {
            if (task.state == GitpodTaskState.CLOSED) {
                continue;
            }
            try {
                const id = GitpodTaskTerminalWidget.toTerminalId(task.id);
                let terminal = this.taskTerminals.get(id);
                if (!terminal) {
                    terminal = await this.terminals.newTerminal({
                        id,
                        kind: 'gitpod-task',
                        title: task.presentation!.name,
                        useServerTitle: false
                    }) as GitpodTaskTerminalWidget;
                    await terminal.start();
                    this.terminals.activateTerminal(terminal, {
                        ref,
                        area: task.presentation.openIn || 'bottom',
                        mode: task.presentation.openMode || 'tab-after'
                    });
                } else if (!IBaseTerminalServer.validateId(terminal.terminalId)) {
                    await terminal.start();
                }
                if (terminal) {
                    ref = terminal;
                }
            } catch (e) {
                console.error('Failed to start Gitpod task terminal:', e);
            }
        }
        await this.updateTerminals(tasks);

        // if there is no terminal at all, lets start one
        if (!this.terminals.all.length) {
            const terminal = await this.terminals.newTerminal({});
            terminal.start();
            this.terminals.open(terminal);
        }
    }

    protected async updateTerminals(tasks: GitpodTask[]): Promise<void> {
        for (const task of tasks) {
            try {
                const id = GitpodTaskTerminalWidget.toTerminalId(task.id);
                const terminal = this.taskTerminals.get(id);
                if (!terminal) {
                    continue;
                }
                if (task.state == GitpodTaskState.CLOSED) {
                    terminal.dispose();
                    continue;
                }
                if (task.state !== GitpodTaskState.RUNNING || terminal.remoteTerminal) {
                    continue;
                }
                terminal.remoteTerminal = task.terminal;
                await terminal.executeCommand({
                    cwd: '/workspace',
                    args: `/theia/supervisor terminal attach ${terminal.remoteTerminal} -ir`.split(' ')
                });
            } catch (e) {
                console.error('Failed to update Gitpod task terminal:', e);
            }
        }
    }
}