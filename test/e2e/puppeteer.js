import puppeteer from 'puppeteer';
import express from 'express';
import path from 'path';
import * as fs from 'fs/promises';

/* CONFIG VARIABLES START */

const idleTime = 9; // 9 seconds - for how long there should be no network requests
const parseTime = 6; // 6 seconds per megabyte

const exceptionList = [

	// video tag not deterministic enough
	'css3d_youtube',
	'webgl_video_kinect',
	'webgl_video_panorama_equirectangular',

	'webaudio_visualizer', // audio can't be analyzed without proper audio hook

	'webgl_effects_ascii', // blink renders text differently in every platform

	'webxr_ar_lighting', // webxr

	'webgl_worker_offscreencanvas', // in a worker, not robust

	// TODO: most of these can be fixed just by increasing idleTime and parseTime
	'webgl_buffergeometry_glbufferattribute',
	'webgl_lensflares',
	'webgl_lines_sphere',
	'webgl_loader_imagebitmap',
	'webgl_loader_texture_lottie',
	'webgl_loader_texture_pvrtc',
	'webgl_morphtargets_face',
	'webgl_nodes_materials_standard',
	'webgl_postprocessing_crossfade',
	'webgl_postprocessing_dof2',
	'webgl_raymarching_reflect',
	'webgl_renderer_pathtracer',
	'webgl_shadowmap',
	'webgl_shadowmap_progressive',
	'webgl_test_memory2',
	'webgl_tiled_forward'

];

/* CONFIG VARIABLES END */

const port = 1234;

const networkTimeout = 1.5; // 1.5 minutes, set to 0 to disable
const renderTimeout = 5; // 5 seconds, set to 0 to disable

const numPages = 16; // use 16 browser pages

const width = 400;
const height = 250;
const viewScale = 2;

let browser;

/* Launch server */

const app = express();
app.use( express.static( path.resolve() ) );
const server = app.listen( port, main );

process.on( 'SIGINT', () => close() );

async function main() {

	/* Find files */

	const files = ( await fs.readdir( 'examples' ) )
		.filter( s => s.slice( - 5 ) === '.html' && s !== 'index.html' )
		.map( s => s.slice( 0, s.length - 5 ) )
		.filter( f => ! exceptionList.includes( f ) );

	/* Launch browser */

	const flags = [ '--hide-scrollbars', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-gl=swiftshader', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader' ];

	const viewport = { width: width * viewScale, height: height * viewScale };

	browser = await puppeteer.launch( {
		headless: true,
		args: flags,
		defaultViewport: viewport,
		handleSIGINT: false
	} );

	/* Prepare injections */

	const cleanPage = await fs.readFile( 'test/e2e/clean-page.js', 'utf8' );
	const injection = await fs.readFile( 'test/e2e/deterministic-injection.js', 'utf8' );

	/* Prepare pages */

	const errorMessagesCache = [];

	const pages = await browser.pages();
	while ( pages.length < numPages && pages.length < files.length ) pages.push( await browser.newPage() );

	for ( const page of pages ) await preparePage( page, injection );

	/* Loop for each file */

	for ( const file of files ) queue.push( makeAttempt( pages, cleanPage, file ) );
	Promise.all( queue );

	close();

}

async function preparePage( page, injection ) {

	/* let page.file, page.pageSize, page.error */

	await page.evaluateOnNewDocument( injection );
	await page.setRequestInterception( true );

	page.on( 'console', async msg => {

		const type = msg.type();

		if ( type !== 'warning' && type !== 'error' ) {

			return;

		}

		const file = page.file;

		if ( file === undefined ) {

			return;

		}

		const args = await Promise.all( msg.args().map( async arg => {
			try {
				return await arg.executionContext().evaluate( arg => arg instanceof Error ? arg.message : arg, arg );
			} catch ( e ) { // Execution context might have been already destroyed
				return arg;
			}
		} ) );

		let text = args.join( ' ' ); // https://github.com/puppeteer/puppeteer/issues/3397#issuecomment-434970058

		text = text.trim();
		if ( text === '' ) return;

		text = file + ': ' + text.replace( /\[\.WebGL-(.+?)\] /g, '' );

		if ( text === `${ file }: JSHandle@error` ) {

			text = `${ file }: Unknown error`;

		}

		if ( text.includes( 'Unable to access the camera/webcam' ) ) {

			return;

		}

		if ( errorMessages.includes( text ) ) {

			return;

		}

		errorMessages.push( text );

		if ( type === 'warning' ) {

			console.warn( text );

		} else {

			page.error = text;

		}

	} );

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
		page.error = undefined;

		/* Load target page */

		try {

			await page.goto( `http://localhost:${ port }/examples/${ file }.html`, {
				waitUntil: 'networkidle0',
				timeout: networkTimeout * 60000
			} );

		} catch ( e ) {

			throw new Error( `Error happened while loading file ${ file }: ${ e }` );

		}

		try {

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

						if ( renderTimeoutExceeded ) {

							clearInterval( waitingLoop );
							reject( 'Render timeout exceeded' );

						} else if ( window._renderFinished ) {

							clearInterval( waitingLoop );
							resolve();

						}

					}, 10 );

				} );

			}, renderTimeout, page.pageSize / 1024 / 1024 * parseTime * 1000 );

		} catch ( e ) {

			if ( ! e.message.includes( 'Render timeout exceeded' ) ) {

				throw new Error( `Error happened while rendering file ${ file }: ${ e }` );

			}

		}

	} catch ( e ) { 

		console.error( e );

	}

	page.file = undefined; // release lock

}

function close() {

	if ( browser !== undefined ) browser.close();
	server.close();
	process.exit( 0 );

}
