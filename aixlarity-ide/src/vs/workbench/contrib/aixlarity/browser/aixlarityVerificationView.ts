import { append, $ } from '../../../../base/browser/dom.js';
import type { TaskVerificationPassport } from './aixlarityVerificationModel.js';

export function renderTaskVerificationPassport(container: HTMLElement, passport: TaskVerificationPassport, onCopy: () => void): HTMLElement {
	const card = append(container, $(`div.aixlarity-verification-passport.${passport.status}`));
	const top = append(card, $('div.aixlarity-verification-top'));
	const title = append(top, $('div.aixlarity-verification-title'));
	append(title, $('span.codicon.codicon-verified'));
	append(title, $('span')).textContent = 'Verification Passport';
	const score = append(top, $('button.aixlarity-verification-score'));
	score.title = 'Copy task verification passport';
	append(score, $('span')).textContent = `${passport.score}%`;
	append(score, $('span.codicon.codicon-copy'));
	score.addEventListener('click', event => {
		event.stopPropagation();
		onCopy();
	});

	const steps = append(card, $('div.aixlarity-verification-steps'));
	for (const step of passport.steps) {
		const item = append(steps, $(`span.aixlarity-verification-step.${step.blocked ? 'blocked' : step.satisfied ? 'ok' : 'missing'}`, {
			title: step.detail,
		}));
		append(item, $(`span.codicon.codicon-${step.blocked ? 'error' : step.satisfied ? 'pass' : 'circle-large-outline'}`));
		append(item, $('span')).textContent = step.label;
	}
	append(card, $('div.aixlarity-verification-summary')).textContent = passport.summary;
	return card;
}
