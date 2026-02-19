// @ts-check
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'out/extension.js',
	external: ['vscode'],
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	minify: production,
	sourcemap: !production,
	logLevel: 'info',
	// Avoid bundling native modules if any slip in transitively
	mainFields: ['main', 'module'],
};

async function main() {
	if (watch) {
		const ctx = await esbuild.context(buildOptions);
		await ctx.watch();
		console.log('[esbuild] Watching for changes…');
	} else {
		await esbuild.build(buildOptions);
		console.log('[esbuild] Build complete');
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
