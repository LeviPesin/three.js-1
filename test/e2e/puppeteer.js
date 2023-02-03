import puppeteer from 'puppeteer';
import express from 'express';
import path from 'path';
import * as fs from 'fs/promises';

const idleTime = 9; // 9 seconds - for how long there should be no network requests
const parseTime = 6; // 6 seconds per megabyte

const port = 1234;

const networkTimeout = 1.5; // 1.5 minutes, set to 0 to disable
const renderTimeout = 5; // 5 seconds, set to 0 to disable

const numPages = 16; // use 16 browser pages

const numCIJobs = 4; // GitHub Actions run the script in 4 threads

let browser;

/* Launch server */

const app = express();
app.use( express.static( path.resolve() ) );
const server = app.listen( port, main );

process.on( 'SIGINT', () => close() );

async function main() {

	/* Find files */

	let files = ( await fs.readdir( 'examples' ) )
		.filter( s => s.slice( - 5 ) === '.html' && s !== 'index.html' )
		.map( s => s.slice( 0, s.length - 5 ) )
		.filter( f => ! ( [ 'webgl_shadowmap_progressive', 'webgl_test_memory2', 'webgl_tiled_forward' ].includes( f ) ) );

	/* Launch browser */

	browser = await puppeteer.launch();

	/* Prepare injections */

	const cleanPage = await fs.readFile( 'test/e2e/clean-page.js', 'utf8' );
	const injection = await fs.readFile( 'test/e2e/deterministic-injection.js', 'utf8' );

	/* Prepare pages */

	const pages = await browser.pages();
	while ( pages.length < numPages ) pages.push( await browser.newPage() );
	for ( const page of pages ) await preparePage( page, injection );

	/* Loop for each file */

	for ( let i = 0; i < numCIJobs; i ++ ) {

		const queue = [];
		for ( let j = Math.floor( files.length * i / numCIJobs ); j < Math.floor( files.length * ( i + 1 ) / numCIJobs ); j ++ )
			queue.push( makeAttempt( pages, cleanPage, files[ j ] ) );
		await Promise.all( queue );

	}

	close(0);

}

async function preparePage( page, injection ) {

	/* let page.file, page.pageSize */

	await page.evaluateOnNewDocument( injection );

	page.on( 'response', async ( response ) => {

		try {

			if ( response.status === 200 ) {

				await response.buffer().then( buffer => page.pageSize += buffer.length );

			}

		} catch {}

	} );

}

async function makeAttempt( pages, cleanPage, file ) {

	const page = await new Promise( ( resolve, reject ) => {

		const interval = setInterval( () => {

			for ( const page of pages ) {

				if ( page.file === undefined ) {

					page.file = file; // acquire lock
					clearInterval( interval );
					resolve( page );
					break;

				}

			}

		}, 100 );

	} );

	try {

		page.pageSize = 0;

		/* Load target page */

		await page.goto( `http://localhost:${ port }/examples/${ file }.html`, {
			waitUntil: 'networkidle0',
			timeout: networkTimeout * 60000
		} );

		/* Render page */

		await page.evaluate( cleanPage );

		await page.waitForNetworkIdle( {
			timeout: networkTimeout * 60000,
			idleTime: idleTime * 1000
		} );

		await page.evaluate( async ( renderTimeout, parseTime ) => {

			await new Promise( resolve => setTimeout( resolve, parseTime ) );

			/* Resolve render promise */

			window._renderStarted = true;

			await new Promise( function ( resolve, reject ) {

				const renderStart = performance._now();

				const waitingLoop = setInterval( function () {

					const renderTimeoutExceeded = ( renderTimeout > 0 ) && ( performance._now() - renderStart > 1000 * renderTimeout );

					if ( renderTimeoutExceeded || window._renderFinished ) {

						clearInterval( waitingLoop );
						resolve();

					}

				}, 10 );

			} );

		}, renderTimeout, page.pageSize / 1024 / 1024 * parseTime * 1000 );

	} catch ( e ) {

		throw e;

	} finally {

		page.file = undefined; // release lock

	}

}

function close( exitCode = 1 ) {

	if ( browser !== undefined ) browser.close();
	server.close();
	process.exit( exitCode );

}
