import puppeteer from 'puppeteer';
import express from 'express';
import path from 'path';
import jimp from 'jimp';
import * as fs from 'fs/promises';

class PromiseQueue {

	constructor( func, ...args ) {

		this.func = func.bind( this, ...args );
		this.promises = [];

	}

	add( ...args ) {

		const promise = this.func( ...args );
		this.promises.push( promise );
		promise.then( () => this.promises.splice( this.promises.indexOf( promise ), 1 ) );

	}

	async waitForAll() {

		while ( this.promises.length > 0 ) {

			await Promise.all( this.promises );

		}

	}

}

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

const networkTimeout = 5; // 5 minutes, set to 0 to disable
const renderTimeout = 5; // 5 seconds, set to 0 to disable

const numPages = 16; // use 16 browser pages

const numCIJobs = 4; // GitHub Actions run the script in 4 threads

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

	const isMakeScreenshot = process.argv[ 2 ] === '--make';

	const exactList = process.argv.slice( isMakeScreenshot ? 3 : 2 )
		.map( f => f.replace( '.html', '' ) );

	const isExactList = exactList.length !== 0;

	let files = ( await fs.readdir( 'examples' ) )
		.filter( s => s.slice( - 5 ) === '.html' && s !== 'index.html' )
		.map( s => s.slice( 0, s.length - 5 ) )
		.filter( f => isExactList ? exactList.includes( f ) : ! exceptionList.includes( f ) );

	if ( isExactList ) {

		for ( const file of exactList ) {

			if ( ! files.includes( file ) ) {

				console.log( `Warning! Unrecognised example name: ${ file }` );

			}

		}

	}

	/* Launch browser */

	const flags = [ '--hide-scrollbars', '--enable-unsafe-webgpu' ];
	flags.push( '--enable-features=Vulkan', '--use-gl=swiftshader', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader' );
	// if ( process.platform === 'linux' ) flags.push( '--enable-features=Vulkan,UseSkiaRenderer', '--use-vulkan=native', '--disable-vulkan-surface', '--disable-features=VaapiVideoDecoder', '--ignore-gpu-blocklist', '--use-angle=vulkan' );

	const viewport = { width: width * viewScale, height: height * viewScale };

	browser = await puppeteer.launch( {
		headless: ! process.env.VISIBLE,
		args: flags,
		defaultViewport: viewport,
		handleSIGINT: false
	} );

	// this line is intended to stop the script if the browser (in headful mode) is closed by user (while debugging)
	// browser.on( 'targetdestroyed', target => ( target.type() === 'other' ) ? close() : null );
	// for some reason it randomly stops the script after about ~30 screenshots processed

	/* Prepare injections */

	const cleanPage = await fs.readFile( 'test/e2e/clean-page.js', 'utf8' );
	const injection = await fs.readFile( 'test/e2e/deterministic-injection.js', 'utf8' );
	const build = ( await fs.readFile( 'build/three.module.js', 'utf8' ) ).replace( /Math\.random\(\) \* 0xffffffff/g, 'Math._random() * 0xffffffff' );

	/* Prepare pages */

	const pages = await browser.pages();
	while ( pages.length < numPages && pages.length < files.length ) pages.push( await browser.newPage() );

	for ( const page of pages ) await preparePage( page, injection, build );

	/* Loop for each file */

	const failedScreenshots = [];

	const queue = new PromiseQueue( makeAttempt, pages, failedScreenshots, cleanPage, isMakeScreenshot );
	for ( let i = 0; i < numCIJobs; i ++ ) {
		for ( let j = Math.floor( files.length * i / numCIJobs ); j < Math.floor( files.length * ( i + 1 ) / numCIJobs ); j ++ )
			queue.add( files[ j ] );

	}
	await queue.waitForAll();

	setTimeout( close, 300, failedScreenshots.length );

}

async function preparePage( page, injection, build ) {

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

	} );

	page.on( 'response', async ( response ) => {

		try {

			if ( response.status === 200 ) {

				await response.buffer().then( buffer => page.pageSize += buffer.length );

			}

		} catch {}

	} );

	page.on( 'request', async ( request ) => {

		if ( request.url() === `http://localhost:${ port }/build/three.module.js` ) {

			await request.respond( {
				status: 200,
				contentType: 'application/javascript; charset=utf-8',
				body: build
			} );

		} else {

			await request.continue();

		}

	} );

}

async function makeAttempt( pages, failedScreenshots, cleanPage, isMakeScreenshot, file, attemptID = 0 ) {

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

		const screenshot = ( await jimp.read( await page.screenshot() ) ).scale( 1 / viewScale );

		if ( page.error !== undefined ) throw new Error( page.error );

	} catch ( e ) {

		console.error( e );
		failedScreenshots.push( file );

	}

	page.file = undefined; // release lock

}

function close( exitCode = 1 ) {

	console.log( 'Closing...' );

	if ( browser !== undefined ) browser.close();
	server.close();
	process.exit( exitCode );

}