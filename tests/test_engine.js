/*
 * Node test of the calculation engine in src/SubExposureCalculator.js.
 *
 * It builds synthetic raw frames for cameras whose read noise, gain and sky
 * rates are known, feeds them to secCompute() through params.loader, and prints
 * what the engine measured next to the truth. There are no assertions: read
 * the output. Measured values should agree with the truth within a few percent
 * and the Moon lines should match the labelled phases.
 *
 * Run:  node tests/test_engine.js
 *       SEED=7 node tests/test_engine.js     (same cases, different noise)
 */
"use strict";

var fs = require( "fs" );
var path = require( "path" );
var vm = require( "vm" );

// ----------------------------------------------------------------------------
// Load the script. PixInsight preprocessor lines (#include, #feature-id, ...)
// are blanked, and the few PJSR globals touched at load time are stubbed.
// ----------------------------------------------------------------------------

function loadEngine()
{
   var file = path.join( __dirname, "..", "src", "SubExposureCalculator.js" );
   var lines = fs.readFileSync( file, "utf8" ).split( "\n" );
   var continued = false;
   for ( var i = 0; i < lines.length; ++i )
   {
      var pre = continued || /^\s*#/.test( lines[i] );
      continued = pre && /\\\s*$/.test( lines[i] );
      if ( pre )
         lines[i] = "";
   }
   function plain( s ) { return String( s ).replace( /<[^>]*>/g, "" ); }
   var sandbox = {
      Dialog: function() {},
      console: {
         writeln: function( s ) { console.log( plain( s ) ); },
         warningln: function( s ) { console.log( plain( s ) ); },
         flush: function() {},
         show: function() {}
      }
   };
   vm.createContext( sandbox );
   vm.runInContext( lines.join( "\n" ), sandbox, { filename: "SubExposureCalculator.js" } );
   return sandbox;
}

// ----------------------------------------------------------------------------
// Random numbers (seeded, so every run gives the same frames)
// ----------------------------------------------------------------------------

function makeRandom( seed )
{
   var a = seed >>> 0;
   function uniform()
   {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul( t ^ (t >>> 15), t | 1 );
      t ^= t + Math.imul( t ^ (t >>> 7), t | 61 );
      return ((t ^ (t >>> 14)) >>> 0)/4294967296;
   }
   var spare = null;
   function gauss()
   {
      if ( spare !== null )
      {
         var s = spare;
         spare = null;
         return s;
      }
      var u = 0, v = 0;
      while ( u == 0 )
         u = uniform();
      v = uniform();
      var r = Math.sqrt( -2*Math.log( u ) ), phi = 2*Math.PI*v;
      spare = r*Math.sin( phi );
      return r*Math.cos( phi );
   }
   function poisson( mean )
   {
      if ( mean <= 0 )
         return 0;
      if ( mean > 30 )
         return Math.max( 0, Math.round( mean + Math.sqrt( mean )*gauss() ) );
      var limit = Math.exp( -mean ), k = 0, p = 1;
      do
      {
         ++k;
         p *= uniform();
      }
      while ( p > limit );
      return k - 1;
   }
   return { uniform: uniform, gauss: gauss, poisson: poisson };
}

// ----------------------------------------------------------------------------
// Frame simulator
//
// camera = { name, bits, scaled, pattern ("" for mono), gain (e- per ADU of the
//            camera's own bit depth), readNoise (e-), offset (ADU of the
//            camera's own bit depth, may be fractional) }
// "scaled" stores the values shifted up to the 16 bit range, as most
// astronomy camera drivers do: a 12 bit camera then only produces multiples
// of 16.
// "noisy" = { fraction, factor } gives that share of the pixels a read noise
// that is factor times higher, in every frame, as real CMOS sensors have. The
// read noise over all pixels is then higher than that of a typical pixel.
// ----------------------------------------------------------------------------

var W = 1200, H = 1200;

// The same pixels are noisy in every frame.
function isNoisy( index, fraction )
{
   var h = Math.imul( index ^ 0x9E3779B9, 0x85EBCA6B );
   h ^= h >>> 13;
   h = Math.imul( h, 0xC2B2AE35 );
   h ^= h >>> 16;
   return (h >>> 0)/4294967296 < fraction;
}

function channelOf( camera, x, y )
{
   if ( camera.pattern == "" )
      return 0;
   return "RGB".indexOf( camera.pattern.charAt( (y & 1)*2 + (x & 1) ) );
}

// meanElectrons( x, y, channel ) gives the expected signal of a pixel.
function makeFrame( camera, name, keywords, random, meanElectrons )
{
   var data = new Uint16Array( W*H );
   var top = Math.pow( 2, camera.bits ) - 1;
   var shift = camera.scaled ? 16 - camera.bits : 0;
   for ( var y = 0; y < H; ++y )
      for ( var x = 0; x < W; ++x )
      {
         var c = channelOf( camera, x, y );
         var mean = meanElectrons ? meanElectrons( x, y, c ) : 0;
         var rn = camera.readNoise;
         if ( camera.noisy && isNoisy( y*W + x, camera.noisy.fraction ) )
            rn *= camera.noisy.factor;
         var electrons = random.poisson( mean ) + rn*random.gauss();
         var v = Math.round( camera.offset + electrons/camera.gain );
         v = (v < 0) ? 0 : ((v > top) ? top : v);
         data[y*W + x] = v << shift;
      }
   var kw = {};
   if ( camera.pattern != "" )
      kw.BAYERPAT = camera.pattern;
   for ( var k in keywords )
      kw[k] = String( keywords[k] );
   return { name: name, path: name, width: W, height: H, data: data, keywords: kw };
}

// A light frame: flat sky, a nebula that doubles the sky over the left third,
// and a sprinkling of stars, some of them saturated.
function makeLight( camera, name, keywords, random, rates, exposure )
{
   var stars = new Float32Array( W*H );
   for ( var s = 0; s < 250; ++s )
   {
      var sx = random.uniform()*W, sy = random.uniform()*H;
      var peak = Math.pow( 10, 1.5 + 3.5*random.uniform() ); // electrons
      for ( var dy = -8; dy <= 8; ++dy )
         for ( var dx = -8; dx <= 8; ++dx )
         {
            var px = Math.round( sx ) + dx, py = Math.round( sy ) + dy;
            if ( px >= 0 && px < W && py >= 0 && py < H )
               stars[py*W + px] += peak*Math.exp( -(dx*dx + dy*dy)/(2*2.2*2.2) );
         }
   }
   var kw = { EXPTIME: exposure };
   for ( var k in keywords )
      kw[k] = keywords[k];
   return makeFrame( camera, name, kw, random, function( x, y, c )
   {
      var sky = rates[c]*exposure;
      if ( x < 0.33*W )
         sky *= 2;
      return sky + stars[y*W + x];
   } );
}

// A flat: bright, with vignetting and a fixed pixel response pattern that is
// identical in both flats of a pair.
function makeFlatPair( camera, random, levelADU16 )
{
   var prnu = new Float32Array( W*H );
   for ( var i = 0; i < prnu.length; ++i )
      prnu[i] = 1 + 0.01*random.gauss();
   var shift = camera.scaled ? 16 - camera.bits : 0;
   var colour = [0.62, 1.0, 0.5];
   function mean( x, y, c )
   {
      var rx = (x - W/2)/(W/2), ry = (y - H/2)/(H/2);
      var vignette = 1 - 0.25*(rx*rx + ry*ry)/2;
      var native = levelADU16/Math.pow( 2, shift );
      return native*camera.gain*vignette*prnu[y*W + x]*(camera.pattern == "" ? 1 : colour[c]);
   }
   return [makeFrame( camera, "flat1", { EXPTIME: 2 }, random, mean ),
           makeFrame( camera, "flat2", { EXPTIME: 2 }, random, mean )];
}

// ----------------------------------------------------------------------------
// Running a case
// ----------------------------------------------------------------------------

function pct( measured, truth )
{
   if ( !isFinite( measured ) || !(truth != 0) )
      return "   n/a";
   var d = 100*(measured/truth - 1);
   return (d >= 0 ? "+" : "") + d.toFixed( 1 ) + "%";
}

function line( label, truth, measured, digits )
{
   console.log( "   " + (label + "                              ").substring( 0, 30 ) +
      " truth " + truth.toFixed( digits ) + "   measured " +
      (isFinite( measured ) ? measured.toFixed( digits ) : "n/a") + "   " + pct( measured, truth ) );
}

function runCase( engine, title, camera, options )
{
   console.log( "" );
   console.log( "==========================================================================" );
   console.log( title );
   console.log( "==========================================================================" );

   var random = makeRandom( options.seed + 1000*(parseInt( process.env.SEED, 10 ) || 0) );
   var store = {};
   function add( frame ) { store[frame.name] = frame; }

   add( makeFrame( camera, "bias1", { EXPTIME: 0.001 }, random, null ) );
   add( makeFrame( camera, "bias2", { EXPTIME: 0.001 }, random, null ) );
   var flats = makeFlatPair( camera, random, options.flatLevel );
   add( flats[0] );
   add( flats[1] );
   var lights = [];
   for ( var i = 0; i < options.lights.length; ++i )
   {
      var L = options.lights[i];
      add( makeLight( camera, L.name, L.keywords, random, L.rates, L.exposure ) );
      lights.push( L.name );
   }

   var shift = camera.scaled ? 16 - camera.bits : 0;
   var step = Math.pow( 2, shift );
   var gainFile = camera.gain/step; // e- per ADU as stored in the file

   // "only" limits which frames may be read, to prove that a saved camera
   // measurement spares the bias and flat frames.
   function paramsFor( mode, only )
   {
      return {
         bias1: "bias1", bias2: "bias2", gainMode: mode, flat1: "flat1", flat2: "flat2",
         manualGain: gainFile, lights: lights, sensor: "auto", bgMode: "tiles",
         targets: [3, 5, 10], fallbackExposure: NaN, siteLat: NaN, siteLon: NaN,
         // hand the engine a copy, because it releases the pixel data when done
         loader: function( name )
         {
            if ( only && only.indexOf( name ) < 0 )
               throw new Error( name + " should not have been read" );
            var f = store[name];
            return { name: f.name, path: f.path, width: f.width, height: f.height,
                     data: new Uint16Array( f.data ), keywords: f.keywords };
         }
      };
   }

   var modes = options.manualOnly ? ["manual"] : ["flats", "manual"];
   var result = null;
   for ( var m = 0; m < modes.length; ++m )
   {
      var r = engine.secCompute( paramsFor( modes[m] ), null );
      var cam = r.camera, names = cam.layout.names;

      console.log( "" );
      console.log( "-- gain " + (modes[m] == "flats" ? "measured from the flat pair" :
         "typed in (the true value)") + " --" );
      var c;
      for ( c = 0; c < names.length; ++c )
         line( "bias level " + names[c] + " (file ADU)", camera.offset*step, cam.biasLevel[c], 2 );
      // The engine's read noise includes the quantisation noise of the ADC,
      // one twelfth of an ADU squared, so that is the truth to compare with.
      var rnTruth = Math.sqrt( camera.readNoise*camera.readNoise + camera.gain*camera.gain/12 );
      for ( c = 0; c < names.length; ++c )
         line( "read noise " + names[c] + " (e-)", rnTruth, cam.rnE[c], 3 );
      if ( camera.noisy )
      {
         // With noisy pixels the truth above is the read noise of the ordinary
         // pixels. The engine's typical-pixel figure sits a little above it,
         // because clipping at 5 sigma removes the noisy pixels only in part.
         var f = camera.noisy.fraction, k = camera.noisy.factor;
         var rmsTruth = Math.sqrt( camera.readNoise*camera.readNoise*(1 - f + f*k*k) + camera.gain*camera.gain/12 );
         for ( c = 0; c < names.length; ++c )
            line( "all-pixel RMS " + names[c] + " (e-)", rmsTruth, cam.rnRmsE[c], 3 );
         console.log( "   (noisy pixels: the read noise lines above compare the typical-pixel figure with the" );
         console.log( "    ordinary pixels' value, so several percent high is expected; the RMS lines should agree)" );
      }
      line( "gain (e-/file ADU)", gainFile, cam.gain, 5 );
      for ( var f = 0; f < r.frames.length; ++f )
      {
         var fr = r.frames[f], truth = options.lights[f].rates;
         for ( c = 0; c < names.length; ++c )
            line( fr.name + " sky rate " + names[c] + " (e-/s)", truth[c], fr.channels[c].rate, 4 );
      }
      if ( r.warnings.length > 0 )
         for ( var w = 0; w < r.warnings.length; ++w )
            console.log( "   WARNING: " + r.warnings[w] );
      if ( m == 0 )
         result = r;
   }

   console.log( "" );
   console.log( "-- console report (first gain mode) --" );
   engine.secConsoleReport( result );

   if ( options.stages )
   {
      // The camera measured on its own, saved as text and read back, the way
      // the script keeps it between runs; then only the light frames.
      console.log( "" );
      console.log( "-- two stages: camera measured once, saved and read back, then light frames only --" );
      var saved = JSON.stringify( engine.secMeasureCamera( paramsFor( "flats" ), null ) );
      var second = paramsFor( "flats", lights );
      second.camera = JSON.parse( saved );
      var again = engine.secCompute( second, null );
      var same = true;
      for ( var a = 0; a < again.frames.length; ++a )
         for ( var b = 0; b < again.frames[a].channels.length; ++b )
            if ( again.frames[a].channels[b].rate !== result.frames[a].channels[b].rate ||
                 again.frames[a].channels[b].noiseRatio !== result.frames[a].channels[b].noiseRatio )
               same = false;
      console.log( "   saved camera measurement: " + saved.length + " characters" );
      console.log( "   bias and flat frames read again: no (the loader would have refused)" );
      console.log( "   sky rates and noise checks identical to the one-step run: " + (same ? "yes" : "NO") );

      // A background region chosen by hand. The simulated nebula doubles the
      // sky over the left third of the frame.
      console.log( "" );
      console.log( "-- your own background region (first light frame) --" );
      var spots = [
         { label: "region on empty sky", x0: Math.round( 0.60*W ), factor: 1 },
         { label: "region on the nebula", x0: Math.round( 0.05*W ), factor: 2 }
      ];
      for ( var q = 0; q < spots.length; ++q )
      {
         var own = paramsFor( "flats", lights );
         own.camera = JSON.parse( saved );
         own.bgMode = "region";
         own.bgRegion = { x0: spots[q].x0, y0: Math.round( 0.3*H ), x1: spots[q].x0 + 300, y1: Math.round( 0.3*H ) + 300,
                          source: "test" };
         var ro = engine.secCompute( own, null );
         console.log( "   " + spots[q].label + ": " + engine.secBackgroundText( ro.background ) );
         for ( var k = 0; k < names.length; ++k )
            line( "  sky rate " + names[k] + " (e-/s)", spots[q].factor*options.lights[0].rates[k],
                  ro.frames[0].channels[k].rate, 4 );
         console.log( "     noise check " + ro.frames[0].channels.map( function( ch ) { return ch.noiseRatio.toFixed( 2 ); } ).join( " / " ) +
            (ro.warnings.length ? "   WARNING: " + ro.warnings.join( " | " ) : "") );
      }
   }
   return result;
}

// ----------------------------------------------------------------------------
// Cases
// ----------------------------------------------------------------------------

var engine = loadEngine();
console.log( engine.SEC_TITLE + " " + engine.SEC_VERSION + " engine test" );

var site = { SITELAT: 52.1, SITELONG: 5.2, RA: 83.82, DEC: -5.39 };
function at( dateObs, filter )
{
   var kw = { "DATE-OBS": dateObs, FILTER: filter };
   for ( var k in site )
      kw[k] = site[k];
   return kw;
}

// 1. The reference camera: 16 bit one-shot-colour, read noise 1.5 e-,
//    gain 0.25 e-/ADU, sky 0.026 / 0.037 / 0.021 e-/s in R / G / B.
//    The four frames are dated at known Moon phases (2026 eclipse dates are
//    exact new and full Moons; quarters to within a few hours).
var osc16 = { name: "16 bit colour", bits: 16, scaled: false, pattern: "RGGB",
              gain: 0.25, readNoise: 1.5, offset: 500.3 };
var rgb = [0.026, 0.037, 0.021];
runCase( engine, "1. 16 bit colour camera (RN 1.5 e-, 0.25 e-/ADU, sky 0.026/0.037/0.021 e-/s)", osc16, {
   seed: 11, flatLevel: 22000, stages: true,
   lights: [
      { name: "new_moon_2026-02-17", exposure: 300, rates: rgb, keywords: at( "2026-02-17T12:01:00", "L-Pro" ) },
      { name: "first_quarter_2026-02-24", exposure: 300, rates: rgb, keywords: at( "2026-02-24T12:28:00", "L-Pro" ) },
      { name: "full_moon_2026-03-03", exposure: 300, rates: rgb, keywords: at( "2026-03-03T11:38:00", "L-Pro" ) },
      { name: "last_quarter_2026-03-11", exposure: 300, rates: rgb, keywords: at( "2026-03-11T09:39:00", "L-Pro" ) }
   ]
} );

// 2. A 12 bit mono camera at unity gain, values stored in steps of 16.
//    1.0 e- per 12 bit ADU is 0.0625 e- per file ADU.
var mono12 = { name: "12 bit mono", bits: 12, scaled: true, pattern: "",
               gain: 1.0, readNoise: 1.7, offset: 50.37 };
runCase( engine, "2. 12 bit mono camera, unity gain, stored in steps of 16 (RN 1.7 e-, sky 0.21 and 0.035 e-/s)", mono12, {
   seed: 22, flatLevel: 24000,
   lights: [
      { name: "lum_60s", exposure: 60, rates: [0.21], keywords: { FILTER: "L" } },
      { name: "ha_300s", exposure: 300, rates: [0.035], keywords: { FILTER: "Ha" } }
   ]
} );

// 3. A 12 bit colour camera at its lowest gain, where read noise is under one
//    ADU of the camera. 4.88 e- per 12 bit ADU is 0.305 e- per file ADU.
var osc12 = { name: "12 bit colour", bits: 12, scaled: true, pattern: "GRBG",
              gain: 4.88, readNoise: 3.6, offset: 10.41 };
runCase( engine, "3. 12 bit colour camera, lowest gain, stored in steps of 16 (RN 3.6 e-, sky 1.3/1.9/1.05 e-/s)", osc12, {
   seed: 33, flatLevel: 24000, stages: true,
   lights: [
      { name: "osc12_120s", exposure: 120, rates: [1.3, 1.9, 1.05], keywords: { FILTER: "UV/IR" } }
   ]
} );

// 4. A 14 bit camera whose values are stored unscaled (0 to 16383), as some
//    DSLR conversions do.
var dslr14 = { name: "14 bit unscaled", bits: 14, scaled: false, pattern: "RGGB",
               gain: 0.8, readNoise: 2.4, offset: 2047.6 };
runCase( engine, "4. 14 bit colour camera, stored unscaled (RN 2.4 e-, 0.8 e-/ADU, sky 0.4/0.6/0.3 e-/s)", dslr14, {
   seed: 44, flatLevel: 5000,
   lights: [
      { name: "dslr_90s", exposure: 90, rates: [0.4, 0.6, 0.3], keywords: {} }
   ]
} );


// 5. The reference camera again, now with 3% of its pixels four times as
//    noisy. The read noise over all pixels is then about 20% above that of an
//    ordinary pixel, and the suggestion becomes a range.
var osc16noisy = { name: "16 bit colour, noisy pixels", bits: 16, scaled: false, pattern: "RGGB",
                   gain: 0.25, readNoise: 1.5, offset: 500.3, noisy: { fraction: 0.03, factor: 4 } };
runCase( engine, "5. 16 bit colour camera with 3% noisy pixels (RN 1.5 e- ordinary, 1.81 e- over all pixels)", osc16noisy, {
   seed: 55, flatLevel: 22000,
   lights: [
      { name: "noisy_300s_a", exposure: 300, rates: rgb, keywords: { FILTER: "L-Pro" } },
      { name: "noisy_300s_b", exposure: 300, rates: rgb, keywords: { FILTER: "L-Pro" } }
   ]
} );

// ----------------------------------------------------------------------------
// 6. The camera database path: one camera measured from many frames.
//    Seven bias frames (so one is left over), one of them with cosmic ray
//    hits; flats through two filters at different brightness, plus one flat
//    that has no partner. The camera is the one of case 5.
// ----------------------------------------------------------------------------

// Flats that share one pixel response pattern. specs = [{ name, filter, level }],
// level in ADU as stored in the file.
function makeFlatSet( camera, random, specs )
{
   var prnu = new Float32Array( W*H );
   for ( var i = 0; i < prnu.length; ++i )
      prnu[i] = 1 + 0.01*random.gauss();
   var shift = camera.scaled ? 16 - camera.bits : 0;
   var colour = [0.62, 1.0, 0.5];
   var out = [];
   specs.forEach( function( spec )
   {
      out.push( makeFrame( camera, spec.name, { EXPTIME: 2, FILTER: spec.filter }, random, function( x, y, c )
      {
         var rx = (x - W/2)/(W/2), ry = (y - H/2)/(H/2);
         var vignette = 1 - 0.25*(rx*rx + ry*ry)/2;
         return spec.level/Math.pow( 2, shift )*camera.gain*vignette*prnu[y*W + x]*(camera.pattern == "" ? 1 : colour[c]);
      } ) );
   } );
   return out;
}

(function()
{
   console.log( "" );
   console.log( "==========================================================================" );
   console.log( "6. One camera from many frames: 7 bias frames, 9 flats through two filters" );
   console.log( "==========================================================================" );
   var camera = osc16noisy;
   var random = makeRandom( 66 + 1000*(parseInt( process.env.SEED, 10 ) || 0) );
   var store = {}, biasNames = [], flatNames = [];
   for ( var b = 1; b <= 7; ++b )
   {
      var bias = makeFrame( camera, "bias" + b, { EXPTIME: 0.001 }, random, null );
      if ( b == 3 ) // cosmic ray hits: 40 saturated pixels in one frame
         for ( var hit = 0; hit < 40; ++hit )
            bias.data[Math.floor( random.uniform()*bias.data.length )] = 60000;
      store[bias.name] = bias;
      biasNames.push( bias.name );
   }
   makeFlatSet( camera, random, [
      { name: "flat_L_1", filter: "L", level: 22000 }, { name: "flat_L_2", filter: "L", level: 22000 },
      { name: "flat_L_3", filter: "L", level: 22000 }, { name: "flat_L_4", filter: "L", level: 22000 },
      { name: "flat_L_bright", filter: "L", level: 30000 },
      { name: "flat_Ha_1", filter: "Ha", level: 9000 }, { name: "flat_Ha_2", filter: "Ha", level: 9000 },
      { name: "flat_Ha_3", filter: "Ha", level: 9000 }, { name: "flat_Ha_4", filter: "Ha", level: 9000 }
   ] ).forEach( function( f ) { store[f.name] = f; flatNames.push( f.name ); } );
   function loader( name )
   {
      var f = store[name];
      return { name: f.name, path: f.path, width: f.width, height: f.height,
               data: new Uint16Array( f.data ), keywords: f.keywords };
   }

   var cam = engine.secMeasureCamera( { biasFrames: biasNames, gainMode: "flats", flatFrames: flatNames,
                                        sensor: "auto", loader: loader }, null );
   var f = camera.noisy.fraction, k = camera.noisy.factor;
   var rmsTruth = Math.sqrt( camera.readNoise*camera.readNoise*(1 - f + f*k*k) + camera.gain*camera.gain/12 );
   console.log( "" );
   console.log( "   pairs used: " + cam.biasPairs + " bias (expected 3), " + cam.flatPairs +
      " flat (expected 4); flats left without a partner: " + cam.flatSkipped + " (expected 1)" );
   line( "gain (e-/file ADU)", camera.gain, cam.gain, 5 );
   cam.gainByFilter.forEach( function( g ) { line( "  through " + g.filter + " (" + g.pairs + " pairs)", camera.gain, g.gain, 5 ); } );
   for ( var c = 0; c < cam.layout.names.length; ++c )
      line( "all-pixel RMS " + cam.layout.names[c] + " (e-)", rmsTruth, cam.rnRmsE[c], 3 );
   for ( c = 0; c < cam.layout.names.length; ++c )
      line( "bias level " + cam.layout.names[c] + " (file ADU)", camera.offset, cam.biasLevel[c], 2 );
   console.log( "   scatter between pairs: read noise " + cam.rnSpreadPct.toFixed( 2 ) + "%, gain " + cam.gainSpreadPct.toFixed( 2 ) + "%" );

   // what the pair with the cosmic ray hits says on its own
   var hitPair = engine.secMeasureCamera( { biasFrames: ["bias3", "bias4"], gainMode: "manual", manualGain: camera.gain,
                                            sensor: "auto", loader: loader }, null );
   console.log( "   the bias pair with cosmic ray hits, measured alone: all-pixel RMS " +
      hitPair.rnRmsE.map( function( v ) { return v.toFixed( 2 ); } ).join( " / " ) + " e- (truth " + rmsTruth.toFixed( 2 ) +
      "); the median over three pairs above is not moved by it" );
   for ( var w = 0; w < cam.warnings.length; ++w )
      console.log( "   WARNING: " + cam.warnings[w] );
   console.log( "" );
   engine.secCameraText( { camera: cam, cameraName: "Simulated camera" } ).forEach( function( l ) { console.log( "   " + l ); } );
})();
