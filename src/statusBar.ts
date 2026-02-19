/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** 
 * Status bar item showing the Slack bot running/stopped state. 
 */
export class BotStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;

	constructor() {
		this.item = vscode.window.createStatusBarItem(
			'vscode-slack-bot.status',
			vscode.StatusBarAlignment.Right,
			100,
		);
		this.item.name = 'Slack Bot Status';
		this.setRunning(false);
		this.item.show();
	}

	setRunning(running: boolean) {
		if (running) {
			this.item.text = '$(check) Slack';
			this.item.tooltip = new vscode.MarkdownString('**Slack Bot is running**\n\nClick to stop');
			this.item.command = 'vscode-slack-bot.stop';
			this.item.backgroundColor = undefined;
			this.item.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
		} else {
			this.item.text = '$(circle-slash) Slack';
			this.item.tooltip = new vscode.MarkdownString('**Slack Bot is stopped**\n\nClick to start');
			this.item.command = 'vscode-slack-bot.start';
			this.item.color = undefined;
		}
	}

	dispose() {
		this.item.dispose();
	}
}
