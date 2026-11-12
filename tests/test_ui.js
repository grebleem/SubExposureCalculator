/*
 * Node smoke test of the dialog and graph code in src/SubExposureCalculator.js.
 *
 * PixInsight cannot run here, so this does two limited things:
 *
 * 1. It builds the main dialog and the graph dialog against stand-in controls
 *    that accept any property or method, and walks through the work flow:
 *    measuring a camera from two frames and from many, the camera list
 *    (select, export, delete, import), Calculate, and a preview as
 *    background. That catches JavaScript mistakes
 *    (undefined names, wrong variables), but NOT wrong PixInsight API names.
 * 2. It draws the graph through a recorder that implements only the drawing
 *    calls the script is meant to use, and fails on any other. The drawing is
 *    written out as SVG files so the layout can be looked at in a browser.
 *    Text widths are approximated, so spacing differs a little in PixInsight.
 *
 * Run:  node tests/test_ui.js [output folder for the SVG files]
 */
"use strict";

var fs = require( "fs" );
var os = require( "os" );
var path = require( "path" );
var vm = require( "vm" );

var outDir = process.argv[2] || fs.mkdtempSync( path.join( os.tmpdir(), "sec-graph-" ) );
var problems = [];

// ----------------------------------------------------------------------------
// Stand-in controls: every property reads back what was stored, anything else
// is another stand-in that can be called or constructed.
// ----------------------------------------------------------------------------

function standIn( label )
{
   var store = {};
   return new Proxy( function() {}, {
      get: function( target, prop )
      {
         if ( typeof prop == "symbol" )
            return undefined;
         if ( Object.prototype.hasOwnProperty.call( store, prop ) )
            return store[prop];
         if ( prop == "toString" || prop == "valueOf" )
            return function() { return "[" + label + "]"; };
         if ( prop == "length" )
            return 0;
         if ( prop == "text" )
            return "";
         return standIn( label + "." + prop );
      },
      set: function( target, prop, value ) { store[prop] = value; return true; },
      apply: function() { return standIn( label + "()" ); },
      construct: function() { return standIn( "new " + label ); }
   } );
}

// ----------------------------------------------------------------------------
// Drawing recorder. Only the calls listed here exist; the script's paint
// routine must not use anything else.
// ----------------------------------------------------------------------------

function colour( argb )
{
   var a = ((argb >>> 24) & 255)/255, r = (argb >>> 16) & 255, g = (argb >>> 8) & 255, b = argb & 255;
   return "rgba(" + r + "," + g + "," + b + "," + a.toFixed( 3 ) + ")";
}

function Pen( color, width, style ) { this.color = color; this.width = width || 1; this.style = style || 1; }
function Brush( color ) { this.color = color; }
function Point( x, y ) { this.x = x; this.y = y; }
function Rect( x0, y0, x1, y1 ) { this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1; }

var ALIGN = { Left: 0x01, Right: 0x02, HorzCenter: 0x04, VertCenter: 0x80 };

function Recorder( width, height )
{
   var svg = [], state = { pen: new Pen( 0xff000000 ), brush: null, font: null, antialiasing: false };
   var calls = 0;
   function check( values, what )
   {
      for ( var i = 0; i < values.length; ++i )
         if ( typeof values[i] != "number" || !isFinite( values[i] ) )
            problems.push( what + ": coordinate is not a finite number (" + values[i] + ")" );
         else if ( values[i] < -1 || values[i] > Math.max( width, height ) + 1 )
            problems.push( what + ": coordinate " + values[i] + " is outside the control" );
   }
   function dash( pen )
   {
      return (pen.style == 2) ? " stroke-dasharray=\"6 4\"" : ((pen.style == 3) ? " stroke-dasharray=\"1 4\"" : "");
   }
   var api = {
      fillRect: function( x0, y0, x1, y1, brush )
      {
         ++calls;
         check( [x0, y0, x1, y1], "fillRect" );
         if ( !(brush instanceof Brush) )
            problems.push( "fillRect without a Brush" );
         svg.push( "<rect x=\"" + x0 + "\" y=\"" + y0 + "\" width=\"" + (x1 - x0) + "\" height=\"" + (y1 - y0) +
            "\" fill=\"" + colour( brush.color ) + "\"/>" );
      },
      drawLine: function( x0, y0, x1, y1 )
      {
         ++calls;
         check( [x0, y0, x1, y1], "drawLine" );
         svg.push( "<line x1=\"" + x0 + "\" y1=\"" + y0 + "\" x2=\"" + x1 + "\" y2=\"" + y1 + "\" stroke=\"" +
            colour( state.pen.color ) + "\" stroke-width=\"" + state.pen.width + "\"" + dash( state.pen ) + "/>" );
      },
      drawPolyline: function( points )
      {
         ++calls;
         var s = [];
         for ( var i = 0; i < points.length; ++i )
         {
            if ( !(points[i] instanceof Point) )
               problems.push( "drawPolyline with something that is not a Point" );
            check( [points[i].x, points[i].y], "drawPolyline" );
            s.push( points[i].x + "," + points[i].y );
         }
         svg.push( "<polyline points=\"" + s.join( " " ) + "\" fill=\"none\" stroke=\"" + colour( state.pen.color ) +
            "\" stroke-width=\"" + state.pen.width + "\" stroke-linejoin=\"round\"" + dash( state.pen ) + "/>" );
      },
      drawCircle: function( x, y, r )
      {
         ++calls;
         check( [x, y, r], "drawCircle" );
         svg.push( "<circle cx=\"" + x + "\" cy=\"" + y + "\" r=\"" + r + "\" fill=\"" +
            (state.brush ? colour( state.brush.color ) : "none") + "\" stroke=\"" + colour( state.pen.color ) + "\"/>" );
      },
      drawTextRect: function( rect, str, align )
      {
         ++calls;
         if ( !(rect instanceof Rect) )
            problems.push( "drawTextRect without a Rect" );
         check( [rect.y0, rect.y1], "drawTextRect \"" + str + "\"" );
         var x = rect.x0, anchor = "start";
         if ( align & ALIGN.Right ) { x = rect.x1; anchor = "end"; }
         else if ( align & ALIGN.HorzCenter ) { x = 0.5*(rect.x0 + rect.x1); anchor = "middle"; }
         // the text itself must stay inside the control
         var tw = fakeFont.width( str );
         var left = (anchor == "start") ? x : ((anchor == "end") ? x - tw : x - 0.5*tw);
         if ( left < 0 || left + tw > width )
            problems.push( "text \"" + str + "\" runs outside the control (" + Math.round( left ) + " to " +
               Math.round( left + tw ) + " of " + width + ")" );
         svg.push( "<text x=\"" + x + "\" y=\"" + (0.5*(rect.y0 + rect.y1)) + "\" text-anchor=\"" + anchor +
            "\" dominant-baseline=\"central\" fill=\"" + colour( state.pen.color ) + "\">" +
            String( str ).replace( /&/g, "&amp;" ).replace( /</g, "&lt;" ) + "</text>" );
      },
      end: function() { ++calls; }
   };
   var settable = { pen: Pen, brush: Brush, font: null, antialiasing: null };
   this.calls = function() { return calls; };
   this.svg = function()
   {
      return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + width + "\" height=\"" + height +
         "\" font-family=\"Helvetica, Arial, sans-serif\" font-size=\"12\">\n" + svg.join( "\n" ) + "\n</svg>\n";
   };
   this.graphics = new Proxy( {}, {
      get: function( target, prop )
      {
         if ( prop in api )
            return api[prop];
         if ( prop in state )
            return state[prop];
         throw new Error( "The paint routine used Graphics." + String( prop ) +
            ", which is not on the list of confirmed drawing calls." );
      },
      set: function( target, prop, value )
      {
         if ( !(prop in settable) )
            throw new Error( "The paint routine set Graphics." + String( prop ) +
               ", which is not on the list of confirmed properties." );
         if ( settable[prop] && !(value instanceof settable[prop]) )
            problems.push( "Graphics." + prop + " set to the wrong kind of object" );
         state[prop] = value;
         return true;
      }
   } );
}

// Roughly the metrics of a 12 pixel sans-serif font.
var fakeFont = { width: function( s ) { return Math.round( 6.4*String( s ).length ); }, ascent: 11, descent: 3 };

// ----------------------------------------------------------------------------
// Load the script with the stand-ins in place
// ----------------------------------------------------------------------------

function loadScript()
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

   // The base of every dialog. Anything a dialog does not define itself is a
   // stand-in, but what a dialog stores has to land on that dialog: if the
   // shared base kept it, every dialog would see every other dialog's state
   // and "a new session" would prove nothing.
   function Dialog() {}
   Dialog.prototype = new Proxy( {}, {
      get: function( target, prop )
      {
         if ( typeof prop == "symbol" )
            return undefined;
         if ( prop == "toString" || prop == "valueOf" )
            return function() { return "[Dialog]"; };
         return standIn( "Dialog." + prop );
      },
      set: function( target, prop, value, receiver )
      {
         Object.defineProperty( receiver, prop, { value: value, writable: true, enumerable: true, configurable: true } );
         return true;
      }
   } );

   var printed = [];
   var sandbox = {
      Dialog: Dialog, Pen: Pen, Brush: Brush, Point: Point, Rect: Rect,
      Graphics: function() { return new Recorder( 760, 400 ).graphics; },
      console: {
         writeln: function( s ) { printed.push( String( s ) ); },
         warningln: function( s )
         {
            printed.push( "WARNING " + s );
            if ( /could not be drawn/.test( s ) )
               problems.push( "console warning: " + s );
         },
         flush: function() {}, show: function() {}
      },
      Settings: {
         store: {}, lastReadOK: false,
         read: function( key ) { this.lastReadOK = (key in this.store); return this.store[key]; },
         write: function( key, type, value ) { this.store[key] = value; }
      },
      processEvents: function() {},
      FrameStyle_Box: 1, StdIcon_Error: 1, StdIcon_Question: 2, StdButton_Ok: 1, StdButton_Yes: 3,
      StdButton_No: 4, DataType_String: 1,
      // files written and read by the script, kept in memory
      File: {
         store: {},
         writeTextFile: function( path, text ) { this.store[path] = String( text ); },
         readTextFile: function( path )
         {
            if ( !(path in this.store) )
               throw new Error( "File not found: " + path );
            return this.store[path];
         },
         exists: function( path ) { return path in this.store; }
      },
      TextAlign_Left: ALIGN.Left, TextAlign_Right: ALIGN.Right, TextAlign_HorzCenter: ALIGN.HorzCenter,
      TextAlign_VertCenter: ALIGN.VertCenter,
      PenStyle_Solid: 1, PenStyle_Dash: 2, PenStyle_Dot: 3
   };
   var controls = ["Label", "Edit", "PushButton", "ComboBox", "TreeBox", "TreeBoxNode", "GroupBox",
                   "HorizontalSizer", "VerticalSizer", "Control", "MessageBox", "OpenFileDialog",
                   "SaveFileDialog", "ViewList"];
   for ( var c = 0; c < controls.length; ++c )
      sandbox[controls[c]] = standIn( controls[c] );
   vm.createContext( sandbox );
   vm.runInContext( lines.join( "\n" ), sandbox, { filename: "SubExposureCalculator.js" } );
   sandbox.__printed = printed;
   return sandbox;
}

var script = loadScript();
console.log( script.SEC_TITLE + " " + script.SEC_VERSION + " dialog and graph smoke test" );

// ----------------------------------------------------------------------------
// 1. A full result from small synthetic frames, pushed through both dialogs
// ----------------------------------------------------------------------------

function tinyFrame( name, level, noise, keywords, seed )
{
   var w = 96, h = 96, data = new Uint16Array( w*h ), a = seed;
   function uniform() { a = (a*1664525 + 1013904223) >>> 0; return (a + 0.5)/4294967296; }
   for ( var i = 0; i < data.length; ++i )
   {
      var g = Math.sqrt( -2*Math.log( uniform() ) )*Math.cos( 2*Math.PI*uniform() );
      data[i] = Math.max( 0, Math.round( level + noise*g ) );
   }
   var kw = { BAYERPAT: "RGGB" };
   for ( var k in keywords )
      kw[k] = String( keywords[k] );
   return { name: name, path: name, width: w, height: h, data: data, keywords: kw };
}

var camKw = { INSTRUME: "Test Cam 26", GAIN: 100, OFFSET: 50, "SET-TEMP": -10 };
var frames = {
   bias1: tinyFrame( "bias1", 500, 6, camKw, 1 ),
   bias2: tinyFrame( "bias2", 500, 6, camKw, 2 ),
   bias3: tinyFrame( "bias3", 500, 6, camKw, 11 ),
   bias4: tinyFrame( "bias4", 500, 6, camKw, 12 ),
   bias5: tinyFrame( "bias5", 500, 6, camKw, 13 ),
   // flats for a gain of 0.25 e-/ADU: shot noise in ADU is the root of signal/gain
   flatL1: tinyFrame( "flatL1", 20500, Math.sqrt( 20000/0.25 ), { FILTER: "L" }, 21 ),
   flatL2: tinyFrame( "flatL2", 20500, Math.sqrt( 20000/0.25 ), { FILTER: "L" }, 22 ),
   flatOdd: tinyFrame( "flatOdd", 26500, Math.sqrt( 26000/0.25 ), { FILTER: "L" }, 23 ),
   flatHa1: tinyFrame( "flatHa1", 12500, Math.sqrt( 12000/0.25 ), { FILTER: "Ha" }, 24 ),
   flatHa2: tinyFrame( "flatHa2", 12500, Math.sqrt( 12000/0.25 ), { FILTER: "Ha" }, 25 ),
   lightA: tinyFrame( "lightA", 540, 9, { EXPTIME: 300, FILTER: "L-Pro", "DATE-OBS": "2026-03-03T11:38:00" }, 3 ),
   lightB: tinyFrame( "lightB", 520, 8, { EXPTIME: 600, FILTER: "Ha <dual & band>" }, 4 )
};

// What a failure message box would have said.
var failures = [];
function newDialog()
{
   var d = new script.SecDialog();
   d.fail = function( message ) { failures.push( message ); };
   return d;
}
function labelText( d )
{
   return String( d.cameraLabel.text ).replace( /<br>/g, "\n   " ).replace( /<\/p><p>/g, "\n   " ).replace( /<\/?p>/g, "" );
}
function expect( condition, what )
{
   console.log( (condition ? "ok   " : "FAIL ") + what );
   if ( !condition )
   {
      problems.push( what );
      if ( failures.length > 0 )
         console.log( "     last message box: " + failures[failures.length - 1] );
   }
}
// Frames by name; "allowed" limits which ones may be read, to prove that a
// saved camera measurement really spares the bias frames.
function loaderFor( allowed )
{
   return function( name )
   {
      if ( allowed && allowed.indexOf( name ) < 0 )
         throw new Error( "the test did not expect " + name + " to be read" );
      var f = frames[name];
      if ( !f )
         throw new Error( "no such frame: " + name );
      return { name: f.name, path: f.path, width: f.width, height: f.height,
               data: new Uint16Array( f.data ), keywords: f.keywords };
   };
}
// A preview on an open image, as far as the script looks at one.
function fakePreview( x0, y0, w, h, imageSize )
{
   return { isNull: false, isPreview: true, fullId: "lightA->Preview01",
            window: { filePath: "lightA",
                      previewRect: function() { return { x0: x0, y0: y0, width: w, height: h }; },
                      mainView: { image: { width: imageSize, height: imageSize } } } };
}

function newCameraDialog( taken )
{
   var d = new script.SecCameraDialog( taken );
   d.fail = function( message ) { failures.push( message ); };
   d.loader = loaderFor( null );
   return d;
}
function lastFailure( pattern )
{
   return failures.length > 0 && pattern.test( failures[failures.length - 1] );
}

try
{
   // ---- a first run: no camera yet ----
   var dialog = newDialog();
   dialog.loader = loaderFor( null );
   expect( dialog.cameras.length == 0 && /No camera yet/.test( dialog.cameraSummary.text ),
           "a fresh start has an empty camera list and says so" );
   dialog.lightPaths = ["lightA", "lightB"];
   dialog.calculate();
   expect( failures.length == 1 && lastFailure( /Step 1/ ), "Calculate without a camera asks for one" );

   // ---- measuring a camera from two bias frames and a typed gain ----
   var cam1 = newCameraDialog( dialog.cameraNames() );
   cam1.measure();
   expect( failures.length == 2 && lastFailure( /two raw bias frames/ ), "measuring without bias frames asks for them" );
   cam1.biasPaths.push( "bias1", "bias2" );
   cam1.measure();
   expect( cam1.entry != null && cam1.entry.name == "Test Cam 26, gain 100, offset 50, -10 °C",
           "the camera is named after its frames: " + (cam1.entry ? cam1.entry.name : "") );
   expect( /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test( cam1.entry.camera.measuredAt ), "the measurement carries the time it was made" );
   dialog.addCamera( cam1.entry );
   expect( dialog.cameras.length == 1 && dialog.currentEntry() === cam1.entry &&
           /Read noise 1\.5\d e- \(typical pixel\).*Gain 0\.2500 e-\/ADU, entered by hand/.test( dialog.cameraSummary.text ),
           "it is added to the list, selected, and summarised under the pull-down" );
   console.log( "   summary: " + dialog.cameraSummary.text );

   dialog.calculate();
   expect( dialog.results != null && dialog.results.cameraName == cam1.entry.name, "Calculate uses the selected camera" );
   var result = dialog.results;
   console.log( "results label after Calculate:" );
   console.log( "   " + labelText( dialog ) );
   expect( labelText( dialog ).indexOf( "Ha <dual" ) < 0, "filter names are escaped in the rich text label" );
   var firstRate = result.frames[0].channels[0].rate;

   // ---- a new session: the list is remembered and no bias frame is read ----
   var second = newDialog();
   expect( second.cameras.length == 1 && second.currentEntry() != null &&
           second.currentEntry().name == cam1.entry.name && second.currentEntry().camera.gain == 0.25,
           "a new session finds the saved camera and selects it" );
   console.log( "results label when the script starts with a saved camera:" );
   console.log( "   " + labelText( second ) );
   second.loader = loaderFor( ["lightA", "lightB"] );
   second.lightPaths = ["lightA", "lightB"];
   second.calculate();
   expect( second.results != null && second.results.frames[0].channels[0].rate == firstRate,
           "Calculate reads only the light frames and gives the same result" );

   // ---- a camera from many frames: five bias frames, five flats through two filters ----
   var cam2 = newCameraDialog( second.cameraNames() );
   cam2.name.text = "  Many frames  ";
   cam2.biasPaths.length = 0;
   cam2.biasPaths.push( "bias1", "bias2", "bias3", "bias4", "bias5" );
   cam2.gainMode.currentItem = 0;
   cam2.measure();
   expect( lastFailure( /two raw flat frames/ ), "choosing flats without adding any asks for them" );
   cam2.flatPaths.push( "flatL1", "flatL2", "flatOdd", "flatHa1", "flatHa2" );
   cam2.measure();
   var many = cam2.entry ? cam2.entry.camera : null;
   expect( many != null && cam2.entry.name == "Many frames" && many.biasPairs == 2 && many.flatPairs == 2 &&
           many.flatSkipped == 1 && many.gainByFilter.length == 2 && Math.abs( many.gain/0.25 - 1 ) < 0.1,
           "five bias frames give two pairs, five flats two pairs and one left over; gain " +
           (many ? many.gain.toFixed( 4 ) : "?") + " e-/ADU (true 0.25)" );
   var said = many ? many.warnings.join( " | " ) : "";
   expect( /odd number of bias frames was given. The last one, bias5/.test( said ) &&
           /1 flat frame\(s\) had no neighbour .* for example flatOdd/.test( said ),
           "the unused bias frame and the unpaired flat are reported" );
   second.addCamera( cam2.entry );
   expect( second.cameras.length == 2 && second.currentEntry() === cam2.entry && second.results === null,
           "the new camera is added and selected, and the old results are cleared" );
   console.log( "results label for the camera from many frames:" );
   console.log( "   " + labelText( second ) );

   // ---- the list: remembered, select, export, delete, import ----
   var third = newDialog();
   third.loader = loaderFor( null );
   expect( third.cameras.length == 2 && third.currentEntry().name == "Many frames",
           "the next session remembers both cameras and the one used last" );
   third.cameraCombo.onItemSelected( 0 );
   expect( third.currentEntry().name == cam1.entry.name, "choosing in the pull-down switches camera" );
   third.cameraCombo.onItemSelected( 1 );
   third.exportCamera( "/somewhere/many.json" );
   var fileText = script.File.store["/somewhere/many.json"];
   expect( typeof fileText == "string" && /"file": "SubExposureCalculator camera"/.test( fileText ),
           "Export writes a camera file of " + (fileText ? fileText.length : 0) + " characters" );
   third.confirm = function() { return false; };
   third.deleteCamera();
   expect( third.cameras.length == 2, "Delete does nothing when the question is answered No" );
   third.confirm = function() { return true; };
   third.deleteCamera();
   expect( third.cameras.length == 1 && third.currentEntry().name == cam1.entry.name,
           "Delete removes the camera and selects the remaining one" );
   third.importCamera( "/somewhere/many.json" );
   expect( third.cameras.length == 2 && third.currentEntry().name == "Many frames" &&
           third.currentEntry().camera.gain == many.gain && third.currentEntry().camera.gainByFilter.length == 2,
           "Import brings it back unchanged" );
   third.importCamera( "/somewhere/many.json" );
   expect( third.cameras.length == 3 && third.currentEntry().name == "Many frames (2)",
           "importing it again keeps both, under a different name" );
   script.File.store["/somewhere/notes.json"] = "{ \"hello\": 1 }";
   var before = failures.length;
   third.importCamera( "/somewhere/notes.json" );
   third.importCamera( "/somewhere/missing.json" );
   expect( failures.length == before + 2 && third.cameras.length == 3, "a wrong or missing file is refused with a message" );
   expect( newDialog().cameras.length == 3, "the list is saved after every change" );

   // ---- the single measurement saved by the previous version is taken over ----
   var keep = script.Settings.store;
   var oldCamera = JSON.parse( JSON.stringify( cam1.entry.camera ) );
   oldCamera.inputs = { bias1: "bias1", bias2: "bias2" };
   script.Settings.store = { "SubExposureCalculator/camera": JSON.stringify( oldCamera ) };
   var migrated = newDialog();
   expect( migrated.cameras.length == 1 && migrated.currentEntry().name == cam1.entry.name,
           "a measurement saved by the previous version appears in the list" );
   script.Settings.store = keep;

   // ---- a preview as background ----
   second.loader = loaderFor( ["lightA", "lightB"] );
   second.bgMode.currentItem = 2;
   second.calculate();
   expect( lastFailure( /preview/ ), "Preview mode without a preview asks for one" );
   second.lightPaths = [];
   second.bgView.currentView = fakePreview( 20, 24, 60, 56, 96 );
   second.bgView.onViewSelected( second.bgView.currentView );
   expect( second.lightPaths.length == 1 && second.lightPaths[0] == "lightA",
           "choosing a preview adds its image to the light frames" );
   second.calculate();
   var bg = second.results ? second.results.background : null;
   expect( bg != null && bg.mode == "region" && bg.region.x0 == 20 && bg.region.y1 == 80 &&
           /Sky background from your region lightA-&gt;Preview01, x 20 to 80, y 24 to 80/.test( labelText( second ) ),
           "Calculate uses the preview's rectangle and the results name it" );
   expect( /background region is small \(60 x 56 pixels\)/.test( second.results.warnings.join( " " ) ),
           "a small region is used, with a warning" );
   var regionResults = second.results;
   second.bgView.currentView = fakePreview( 20, 24, 60, 56, 200 );
   second.calculate();
   expect( lastFailure( /200 x 200 pixels, but the frames of this camera are 96 x 96/ ),
           "a preview on an image of another size is refused" );
   var csvHead = script.secCsvReport( regionResults ).split( "\n" );
   expect( /,background_from$/.test( csvHead[0] ) && /your region lightA->Preview01/.test( csvHead[1] ),
           "the CSV records where the background came from" );

   // ---- the graph window ----
   var graph = new script.SecGraphDialog( result );
   graph.select( 1 );
   graph.select( 0 );
   // give the stand-in control what a real one has, then run its paint handler
   graph.plot.width = 760;
   graph.plot.height = 400;
   graph.plot.font = fakeFont;
   graph.plot.displayPixelRatio = 1;
   graph.plot.onPaint();
   console.log( "ok   graph dialog built, both filters selected, paint handler ran" );
   script.__printed.length = 0;
   script.secConsoleReport( regionResults );
   for ( var p = 0; p < script.__printed.length; ++p )
      if ( /^Sky background|^Camera |^Scatter/.test( script.__printed[p] ) )
         console.log( "console: " + script.__printed[p] );
}
catch ( e )
{
   problems.push( "dialog code threw: " + (e.stack || e) );
}

// ----------------------------------------------------------------------------
// 2. The graph itself, for several kinds of result and several sizes
// ----------------------------------------------------------------------------

var cases = [
   // read noise of all pixels well above the typical pixel: the suggestion is a range
   { file: "colour_range", size: [760, 400], scale: 1,
     s: script.secSuggest( "HaO3", ["R", "G", "B"], [0.0280, 0.0372, 0.0209], [1.137, 1.144, 1.167],
                           [1.436, 1.451, 1.480], [3, 5, 10], [300] ) },
   { file: "mono_range", size: [760, 400], scale: 1,
     s: script.secSuggest( "L", ["L"], [0.21], [1.4], [1.9], [3, 5, 10], [60] ) },
   { file: "colour_range_hidpi", size: [1520, 800], scale: 2,
     s: script.secSuggest( "HaO3", ["R", "G", "B"], [0.0280, 0.0372, 0.0209], [1.137, 1.144, 1.167],
                           [1.436, 1.451, 1.480], [3, 5, 10], [300] ) },
   // a different channel sets each end of the range
   { file: "colour_range_two_slowest", size: [760, 400], scale: 1,
     s: script.secSuggest( "L-Pro", ["R", "G", "B"], [0.030, 0.045, 0.031], [1.2, 1.2, 1.25],
                           [1.9, 1.5, 1.5], [3, 5, 10], [120] ) },
   // both read noise figures the same: a single suggestion, as with simulated frames
   { file: "colour_single", size: [760, 400], scale: 1,
     s: script.secSuggest( "L-Pro", ["R", "G", "B"], [0.026, 0.037, 0.021], [1.5, 1.5, 1.5],
                           [1.5, 1.5, 1.5], [3, 5, 10], [300] ) },
   { file: "colour_dualband", size: [760, 400], scale: 1,
     s: script.secSuggest( "L-eXtreme", ["R", "G", "B"], [0.031, 0.0052, 0.0041], [1.5, 1.5, 1.5],
                           [1.9, 1.9, 1.9], [3, 5, 10], [300, 600] ) },
   { file: "mono_many_targets_far_exposure", size: [900, 520], scale: 1,
     s: script.secSuggest( "Ha", ["L"], [0.004], [1.2], [1.5], [1, 2, 3, 5, 10, 20, 50], [5] ) },
   { file: "colour_one_channel_missing", size: [760, 400], scale: 1,
     s: script.secSuggest( "(none)", ["R", "G", "B"], [0.4, 0.6, NaN], [2.4, 2.4, 2.4], [3.0, 3.0, 3.0], [5], [90] ) },
   // too narrow for the side panel, and too small to draw at all
   { file: "narrow_no_panel", size: [420, 300], scale: 1,
     s: script.secSuggest( "L", ["L"], [0.21], [1.4], [1.9], [3, 5, 10], [60] ) },
   { file: "too_small", size: [150, 90], scale: 1,
     s: script.secSuggest( "L", ["L"], [0.21], [1.72], [1.72], [3, 5, 10], [60] ) }
];

for ( var i = 0; i < cases.length; ++i )
{
   var c = cases[i], before = problems.length;
   try
   {
      var model = script.secPlotModel( c.s );
      var font = (c.scale == 1) ? fakeFont :
         { width: function( t ) { return 2*fakeFont.width( t ); }, ascent: 22, descent: 6 };
      var rec = new Recorder( c.size[0], c.size[1] );
      script.secPaintPlot( rec.graphics, c.size[0], c.size[1], font, c.scale, model );
      var svg = rec.svg();
      if ( c.scale != 1 )
         svg = svg.replace( "font-size=\"12\"", "font-size=\"24\"" );
      fs.writeFileSync( path.join( outDir, c.file + ".svg" ), svg );
      console.log( (problems.length == before ? "ok   " : "FAIL ") + c.file + ": " + rec.calls() +
         " drawing calls, time axis " + model.t0.toFixed( 1 ) + " to " + model.t1.toFixed( 0 ) + " s, suggested " +
         script.secSuggestionSpan( c.s ) + (c.s.range ? " (set by " + c.s.channels[c.s.slow].name + " and " +
         c.s.all.channels[c.s.all.slow].name + ")" : "") );
   }
   catch ( e )
   {
      problems.push( c.file + " threw: " + (e.stack || e) );
   }
}

console.log( "SVG files written to " + outDir );
if ( problems.length > 0 )
{
   console.log( "" );
   console.log( problems.length + " PROBLEM(S):" );
   for ( var q = 0; q < problems.length; ++q )
      console.log( " - " + problems[q] );
   process.exit( 1 );
}
console.log( "No problems found." );
