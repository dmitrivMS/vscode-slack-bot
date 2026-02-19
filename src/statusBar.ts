/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	type Disposable,
	type StatusBarItem,
	MarkdownString,
	StatusBarAlignment,
	ThemeColor,
	window,
} from 'vscode';

/** 
 * Status bar item showing the Slack bot running/stopped state. 
 */
export class BotStatusBar implements Disposable {
	private readonly item: StatusBarItem;

	constructor() {
		this.item = window.createStatusBarItem(
			'vscode-slack-bot.status',
			StatusBarAlignment.Right,
			100,
		);
		this.item.name = 'Slack Bot Status';
		this.setRunning(false);
		this.item.show();
	}

	setRunning(running: boolean) {
		if (running) {
			this.item.text = '$(check) Slack';
			this.item.tooltip = new MarkdownString('**Slack Bot is running**\n\nClick to stop');
			this.item.command = 'vscode-slack-bot.stop';
			this.item.backgroundColor = undefined;
			this.item.color = new ThemeColor('statusBarItem.prominentForeground');
		} else {
			this.item.text = '$(circle-slash) Slack';
			this.item.tooltip = new MarkdownString('**Slack Bot is stopped**\n\nClick to start');
			this.item.command = 'vscode-slack-bot.start';
			this.item.color = undefined;
		}
	}

	dispose() {
		this.item.dispose();
	}
}
