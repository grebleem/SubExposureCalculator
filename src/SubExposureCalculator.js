/*
 * SubExposureCalculator.js
 *
 * A guided PixInsight script that measures your camera (read noise, bias
 * level, conversion gain) and your sky (background rate through each filter)
 * from raw frames, then reports the sub-exposure time needed to make read
 * noise an insignificant part of the stacked image.
 *
 * Inputs
 *   - two raw bias frames (same gain / offset / temperature as the lights)
 *   - conversion gain: two raw flat frames, or a typed e-/ADU value
 *   - one or more raw, uncalibrated light frames
 *
 * One-shot-colour frames are separated into their R, G and B Bayer positions
 * without interpolation. Mono frames are used as they are.
 *
 * Copyright (c) 2026 Bastiaan Meelberg. Released under the MIT License.
 * https://github.com/grebleem/SubExposureCalculator
 */

#feature-id    Utilities > SubExposureCalculator
#feature-info  Measures read noise, conversion gain and sky background from raw frames \
               and calculates sky-limited sub-exposure times. Works for mono and \
               one-shot-colour cameras.

#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/DataType.jsh>

var SEC_TITLE = "SubExposureCalculator";
var SEC_VERSION = "1.0.1";
var SEC_ADU_MAX = 65535;

// ============================================================================
// Small helpers
// ============================================================================

function secTrim( s )
{
   return String( s ).replace( /^\s+|\s+$/g, "" );
}

function secStripKeyword( v )
{
   v = secTrim( v );
   if ( v.length > 0 && v.charAt( 0 ) == "'" )
      v = v.replace( /^'/, "" ).replace( /'$/, "" );
   return secTrim( v );
}

function secBaseName( path )
{
   var p = String( path ).replace( /\\/g, "/" );
   var i = p.lastIndexOf( "/" );
   return (i >= 0) ? p.substring( i + 1 ) : p;
}

function secNum( v )
{
   if ( v === undefined || v === null )
      return NaN;
   var s = secTrim( v );
   if ( s == "" || /[\s:]/.test( s ) ) // empty or sexagesimal
      return NaN;
   var x = parseFloat( s );
   return isFinite( x ) ? x : NaN;
}

function secKw( frame, names )
{
   for ( var i = 0; i < names.length; ++i )
   {
      var v = frame.keywords[names[i]];
      if ( v !== undefined && v !== "" )
         return v;
   }
   return "";
}

function secMedianOf( a )
{
   var b = a.slice( 0 ).sort( function( x, y ) { return x - y; } );
   var n = b.length;
   if ( n == 0 )
      return NaN;
   return (n & 1) ? b[(n - 1) >> 1] : 0.5*(b[n/2 - 1] + b[n/2]);
}

function secFmt( x, digits )
{
   return isFinite( x ) ? x.toFixed( digits ) : "n/a";
}

function secFmtTime( seconds )
{
   if ( !isFinite( seconds ) || seconds <= 0 )
      return "n/a";
   if ( seconds < 120 )
      return Math.round( seconds ) + " s";
   return (seconds/60).toFixed( 1 ) + " min";
}

function secCsv( s )
{
   s = String( s );
   if ( s.indexOf( "," ) >= 0 || s.indexOf( "\"" ) >= 0 )
      return "\"" + s.replace( /\"/g, "\"\"" ) + "\"";
   return s;
}

// ============================================================================
// Histogram statistics. Bin i holds the samples with value i + offset and is
// treated as covering [value - 0.5, value + 0.5), which gives sub-ADU medians
// for integer data.
// ============================================================================

function SecHist( counts, offset )
{
   this.counts = counts;
   this.offset = offset || 0;
   this.size = counts.length;
   this.cum = new Float64Array( this.size + 1 );
   var t = 0;
   for ( var i = 0; i < this.size; ++i )
   {
      this.cum[i] = t;
      t += counts[i];
   }
   this.cum[this.size] = t;
   this.n = t;
}

// Number of samples below the real value x.
SecHist.prototype.cdf = function( x )
{
   var u = x - this.offset + 0.5;
   if ( u <= 0 )
      return 0;
   if ( u >= this.size )
      return this.n;
   var i = Math.floor( u );
   return this.cum[i] + this.counts[i]*(u - i);
};

SecHist.prototype.quantile = function( q )
{
   if ( this.n == 0 )
      return NaN;
   var target = q*this.n;
   var lo = 0, hi = this.size - 1;
   while ( lo < hi )
   {
      var mid = (lo + hi) >> 1;
      if ( this.cum[mid + 1] >= target )
         hi = mid;
      else
         lo = mid + 1;
   }
   var c = this.counts[lo];
   var frac = (c > 0) ? (target - this.cum[lo])/c : 0.5;
   return lo + frac - 0.5 + this.offset;
};

SecHist.prototype.median = function()
{
   return this.quantile( 0.5 );
};

// Median absolute deviation from the median.
SecHist.prototype.mad = function()
{
   if ( this.n == 0 )
      return NaN;
   var m = this.median();
   var lo = 0, hi = this.size;
   for ( var it = 0; it < 48; ++it )
   {
      var d = 0.5*(lo + hi);
      if ( this.cdf( m + d ) - this.cdf( m - d ) >= 0.5*this.n )
         hi = d;
      else
         lo = d;
   }
   return 0.5*(lo + hi);
};

// Count, mean and standard deviation of the samples with lo <= value <= hi.
SecHist.prototype.moments = function( lo, hi )
{
   var i0 = Math.max( 0, Math.ceil( lo - this.offset ) );
   var i1 = Math.min( this.size - 1, Math.floor( hi - this.offset ) );
   var n = 0, s = 0, s2 = 0;
   for ( var i = i0; i <= i1; ++i )
   {
      var c = this.counts[i];
      if ( c > 0 )
      {
         n += c;
         s += c*i;
         s2 += c*i*i;
      }
   }
   if ( n < 2 )
      return { n: n, mean: NaN, sd: NaN };
   var mean = s/n;
   var v = (s2 - n*mean*mean)/(n - 1);
   return { n: n, mean: mean + this.offset, sd: Math.sqrt( Math.max( 0, v ) ) };
};

// Iterative sigma-clipped mean and standard deviation.
SecHist.prototype.clipped = function( k )
{
   var c = this.median();
   var s = 1.4826*this.mad();
   if ( !(s > 0) )
      s = 0.5;
   var n = this.n;
   for ( var it = 0; it < 8; ++it )
   {
      var m = this.moments( c - k*s, c + k*s );
      if ( m.n < 2 || !(m.sd > 0) )
         break;
      var done = Math.abs( m.sd - s ) < 1e-4*s;
      c = m.mean;
      s = m.sd;
      n = m.n;
      if ( done )
         break;
   }
   return { n: n, mean: c, sd: s };
};

// ============================================================================
// Frame access
// ============================================================================

/*
 * Loads a raw frame from disk and returns its pixels as 16 bit ADU values.
 * The window is never shown and is closed again immediately.
 */
function secLoadFrame( path )
{
   var wins = ImageWindow.open( path );
   if ( !wins || wins.length == 0 )
      throw new Error( "Unable to open file: " + path );

   var frame = null;
   var error = null;
   try
   {
      var win = wins[0];
      var img = win.mainView.image;
      if ( img.numberOfChannels != 1 )
         throw new Error( secBaseName( path ) + " has " + img.numberOfChannels +
            " channels. Please use raw frames straight from the camera " +
            "(not debayered, not stacked, not calibrated)." );

      var w = img.width, h = img.height;
      var buf = new Float32Array( w*h );
      img.getSamples( buf, new Rect( 0, 0, w, h ), 0 );
      var normMax = img.maximum();

      var kw = {};
      var list = win.keywords;
      for ( var i = 0; i < list.length; ++i )
         kw[String( list[i].name ).toUpperCase()] = secStripKeyword( list[i].value );

      frame = { path: path, name: secBaseName( path ), width: w, height: h,
                data: secToADU16( buf, normMax ), keywords: kw };
   }
   catch ( e )
   {
      error = e;
   }

   for ( var j = 0; j < wins.length; ++j )
      try { wins[j].forceClose(); } catch ( e2 ) {}

   if ( error != null )
      throw error;
   return frame;
}

/*
 * Converts pixel samples to 16 bit ADU. normMax is the image maximum in
 * PixInsight's normalised [0,1] range, which lets this work whether the
 * samples arrive normalised or in their native integer range.
 */
function secToADU16( buf, normMax )
{
   var n = buf.length;
   var bufMax = 0;
   for ( var i = 0; i < n; ++i )
      if ( buf[i] > bufMax )
         bufMax = buf[i];
   var scale = (bufMax > 0 && normMax > 0) ? normMax*SEC_ADU_MAX/bufMax : SEC_ADU_MAX;
   var out = new Uint16Array( n );
   for ( var j = 0; j < n; ++j )
   {
      var v = buf[j]*scale + 0.5;
      out[j] = (v <= 0) ? 0 : ((v >= SEC_ADU_MAX) ? SEC_ADU_MAX : v);
   }
   return out;
}

/*
 * Describes how pixels map to channels. For a colour sensor the two green
 * positions of the Bayer pattern are pooled into one G channel.
 */
function secLayout( sensor, frame )
{
   var pat = "";
   if ( sensor == "auto" )
   {
      var b = String( secKw( frame, ["BAYERPAT"] ) ).toUpperCase().replace( /[^RGB]/g, "" );
      if ( b.length == 4 )
         pat = b;
   }
   else if ( sensor != "mono" )
      pat = sensor;

   if ( pat == "" )
      return { cfa: false, pattern: "", nch: 1, names: ["L"], map: [0, 0, 0, 0] };

   var idx = { R: 0, G: 1, B: 2 };
   var map = [];
   for ( var i = 0; i < 4; ++i )
      map.push( idx[pat.charAt( i )] );
   return { cfa: true, pattern: pat, nch: 3, names: ["R", "G", "B"], map: map };
}

function secNewCounts( nch, size )
{
   var H = [];
   for ( var c = 0; c < nch; ++c )
      H.push( new Float64Array( size ) );
   return H;
}

// Per-channel histograms of one frame inside the rectangle [x0,x1) x [y0,y1).
function secHistograms( data, w, layout, x0, y0, x1, y1 )
{
   var H = secNewCounts( layout.nch, SEC_ADU_MAX + 1 );
   var map = layout.map;
   for ( var y = y0; y < y1; ++y )
   {
      var row = y*w;
      var h0 = H[map[(y & 1)*2]], h1 = H[map[(y & 1)*2 + 1]];
      for ( var x = x0; x < x1; ++x )
         if ( x & 1 )
            h1[data[row + x]]++;
         else
            h0[data[row + x]]++;
   }
   var out = [];
   for ( var c = 0; c < layout.nch; ++c )
      out.push( new SecHist( H[c], 0 ) );
   return out;
}

// Per-channel histograms of the pixel-by-pixel difference a - b.
function secDiffHistograms( a, b, w, layout, x0, y0, x1, y1 )
{
   var H = secNewCounts( layout.nch, 2*SEC_ADU_MAX + 1 );
   var map = layout.map;
   for ( var y = y0; y < y1; ++y )
   {
      var row = y*w;
      var h0 = H[map[(y & 1)*2]], h1 = H[map[(y & 1)*2 + 1]];
      for ( var x = x0; x < x1; ++x )
      {
         var d = a[row + x] - b[row + x] + SEC_ADU_MAX;
         if ( x & 1 )
            h1[d]++;
         else
            h0[d]++;
      }
   }
   var out = [];
   for ( var c = 0; c < layout.nch; ++c )
      out.push( new SecHist( H[c], -SEC_ADU_MAX ) );
   return out;
}

/*
 * Background estimate that tolerates nebulosity: the frame is cut into a grid
 * of tiles, each tile's median is taken per channel, and the requested
 * percentile of those tile medians is returned.
 */
function secTileBackground( data, w, h, layout, globalMedian, percentile )
{
   var BINS = 2048;
   var nx = Math.max( 1, Math.min( 16, Math.floor( w/128 ) ) );
   var ny = Math.max( 1, Math.min( 16, Math.floor( h/128 ) ) );
   var nch = layout.nch, map = layout.map;
   var lo = [], counts = [], below = [], total = [], medians = [];
   for ( var c = 0; c < nch; ++c )
   {
      lo.push( Math.max( 0, Math.round( globalMedian[c] ) - 768 ) );
      counts.push( new Float64Array( BINS ) );
      below.push( 0 );
      total.push( 0 );
      medians.push( [] );
   }

   for ( var ty = 0; ty < ny; ++ty )
   {
      var y0 = Math.floor( ty*h/ny ), y1 = Math.floor( (ty + 1)*h/ny );
      for ( var tx = 0; tx < nx; ++tx )
      {
         var x0 = Math.floor( tx*w/nx ), x1 = Math.floor( (tx + 1)*w/nx );
         for ( var c1 = 0; c1 < nch; ++c1 )
         {
            var cc = counts[c1];
            for ( var i = 0; i < BINS; ++i )
               cc[i] = 0;
            below[c1] = 0;
            total[c1] = 0;
         }
         for ( var y = y0; y < y1; ++y )
         {
            var row = y*w;
            for ( var x = x0; x < x1; ++x )
            {
               var ch = map[(y & 1)*2 + (x & 1)];
               var k = data[row + x] - lo[ch];
               total[ch]++;
               if ( k < 0 )
                  below[ch]++;
               else if ( k < BINS )
                  counts[ch][k]++;
            }
         }
         for ( var c2 = 0; c2 < nch; ++c2 )
         {
            var target = 0.5*total[c2];
            if ( total[c2] == 0 || below[c2] >= target )
               continue; // empty tile, or median outside the window
            var acc = below[c2], found = false;
            for ( var b = 0; b < BINS; ++b )
            {
               var n = counts[c2][b];
               if ( n > 0 && acc + n >= target )
               {
                  medians[c2].push( lo[c2] + b - 0.5 + (target - acc)/n );
                  found = true;
                  break;
               }
               acc += n;
            }
            // not found: median above the window (very bright tile), skip it
         }
      }
   }

   var out = [];
   for ( var c3 = 0; c3 < nch; ++c3 )
   {
      var m = medians[c3].sort( function( p, q ) { return p - q; } );
      if ( m.length == 0 )
      {
         out.push( globalMedian[c3] );
         continue;
      }
      var pos = percentile*(m.length - 1);
      var i0 = Math.floor( pos ), i1 = Math.min( m.length - 1, i0 + 1 );
      out.push( m[i0] + (m[i1] - m[i0])*(pos - i0) );
   }
   return out;
}

// ============================================================================
// Sun and Moon (low precision, good to a fraction of a degree)
// ============================================================================

function secParseDateObs( s )
{
   var m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec( secTrim( s ) );
   if ( !m )
      return NaN;
   var sec = parseFloat( m[6] );
   return Date.UTC( +m[1], +m[2] - 1, +m[3], +m[4], +m[5], Math.floor( sec ),
                    Math.round( (sec - Math.floor( sec ))*1000 ) );
}

function secSkyInfo( jd, latDeg, lonDeg, raDeg, decDeg )
{
   var R = Math.PI/180;
   function sind( x ) { return Math.sin( x*R ); }
   function cosd( x ) { return Math.cos( x*R ); }
   function norm( x ) { x = x % 360; return (x < 0) ? x + 360 : x; }

   var d = jd - 2451545.0;
   var T = d/36525;
   var eps = 23.4393 - 0.0000004*d;

   // Sun
   var g = 357.528 + 0.9856003*d;
   var sunLon = norm( 280.460 + 0.9856474*d + 1.915*sind( g ) + 0.020*sind( 2*g ) );

   // Moon
   var moonLon = norm( 218.32 + 481267.881*T
      + 6.29*sind( 135.0 + 477198.87*T ) - 1.27*sind( 259.3 - 413335.36*T )
      + 0.66*sind( 235.7 + 890534.22*T ) + 0.21*sind( 269.9 + 954397.74*T )
      - 0.19*sind( 357.5 + 35999.05*T ) - 0.11*sind( 186.5 + 966404.03*T ) );
   var moonLat = 5.13*sind( 93.3 + 483202.02*T ) + 0.28*sind( 228.2 + 960400.89*T )
      - 0.28*sind( 318.3 + 6003.15*T ) - 0.17*sind( 217.6 - 407332.21*T );
   var moonPar = 0.9508 + 0.0518*cosd( 135.0 + 477198.87*T ) + 0.0095*cosd( 259.3 - 413335.36*T )
      + 0.0078*cosd( 235.7 + 890534.22*T ) + 0.0028*cosd( 269.9 + 954397.74*T );

   // Illuminated fraction
   var cosElong = cosd( moonLat )*cosd( moonLon - sunLon );
   var elong = Math.acos( Math.max( -1, Math.min( 1, cosElong ) ) )/R;
   var phaseAngle = 180 - elong - 0.1468*sind( elong );
   var info = {
      moonIllum: 0.5*(1 + cosd( phaseAngle )),
      moonWaxing: norm( moonLon - sunLon ) < 180,
      moonAlt: NaN, moonSep: NaN, sunAlt: NaN, targetAlt: NaN
   };

   function toEquatorial( lon, lat )
   {
      var l = cosd( lat )*cosd( lon );
      var m = cosd( eps )*cosd( lat )*sind( lon ) - sind( eps )*sind( lat );
      var n = sind( eps )*cosd( lat )*sind( lon ) + cosd( eps )*sind( lat );
      return { ra: norm( Math.atan2( m, l )/R ), dec: Math.asin( n )/R };
   }
   var moon = toEquatorial( moonLon, moonLat );
   var sun = toEquatorial( sunLon, 0 );

   var haveTarget = isFinite( raDeg ) && isFinite( decDeg );
   if ( haveTarget )
   {
      var cs = sind( decDeg )*sind( moon.dec ) + cosd( decDeg )*cosd( moon.dec )*cosd( raDeg - moon.ra );
      info.moonSep = Math.acos( Math.max( -1, Math.min( 1, cs ) ) )/R;
   }

   if ( isFinite( latDeg ) && isFinite( lonDeg ) )
   {
      var lst = norm( 280.46061837 + 360.98564736629*d + lonDeg );
      var altitude = function( ra, dec )
      {
         var s = sind( latDeg )*sind( dec ) + cosd( latDeg )*cosd( dec )*cosd( lst - ra );
         return Math.asin( Math.max( -1, Math.min( 1, s ) ) )/R;
      };
      var ma = altitude( moon.ra, moon.dec );
      info.moonAlt = ma - moonPar*cosd( ma ); // topocentric
      info.sunAlt = altitude( sun.ra, sun.dec );
      if ( haveTarget )
         info.targetAlt = altitude( raDeg, decDeg );
   }
   return info;
}

// ============================================================================
// The calculation
// ============================================================================

function secEfficiency( m )
{
   return (m > 0) ? Math.sqrt( m/(m + 1) ) : 0;
}

function secCheckSize( a, b )
{
   if ( a.width != b.width || a.height != b.height )
      throw new Error( b.name + " is " + b.width + "x" + b.height + " pixels, but " +
         a.name + " is " + a.width + "x" + a.height + ". All frames must come from " +
         "the same camera with the same binning." );
}

function secCheckKeyword( ref, frame, names, label, warnings )
{
   var a = secNum( secKw( ref, names ) ), b = secNum( secKw( frame, names ) );
   if ( isFinite( a ) && isFinite( b ) && Math.abs( a - b ) > 1e-6 )
      warnings.push( frame.name + ": " + label + " is " + b + " but the bias frames use " + a +
         ". Read noise, bias level and gain only apply at the same " + label + "." );
}

/*
 * p = { bias1, bias2, gainMode ("flats" | "manual"), flat1, flat2, manualGain,
 *       lights [], sensor ("auto" | "mono" | "RGGB" ...), bgMode ("tiles" | "frame"),
 *       targets [], fallbackExposure, siteLat, siteLon, loader (optional) }
 */
function secCompute( p, log )
{
   var load = p.loader || secLoadFrame;
   var warnings = [];
   log = log || function() {};

   // ---- 1. Bias pair: bias level and read noise ---------------------------
   log( "Reading bias frames..." );
   var b1 = load( p.bias1 ), b2 = load( p.bias2 );
   secCheckSize( b1, b2 );
   var w = b1.width, h = b1.height;
   var layout = secLayout( p.sensor, b1 );
   var nch = layout.nch;

   var biasExp = secNum( secKw( b1, ["EXPTIME", "EXPOSURE"] ) );
   if ( isFinite( biasExp ) && biasExp > 1 )
      warnings.push( "The bias frames have an exposure of " + biasExp + " s. Use the shortest " +
         "exposure your camera allows, otherwise dark current is counted as read noise." );

   var hb1 = secHistograms( b1.data, w, layout, 0, 0, w, h );
   var hb2 = secHistograms( b2.data, w, layout, 0, 0, w, h );
   var hbd = secDiffHistograms( b1.data, b2.data, w, layout, 0, 0, w, h );
   var biasLevel = [], rnADU = [], rnRmsADU = [];
   for ( var c = 0; c < nch; ++c )
   {
      biasLevel.push( 0.5*(hb1[c].median() + hb2[c].median()) );
      rnADU.push( hbd[c].clipped( 5 ).sd/Math.SQRT2 );
      // plain RMS over every pixel, including the noisy outlier pixels
      rnRmsADU.push( hbd[c].moments( -SEC_ADU_MAX, SEC_ADU_MAX ).sd/Math.SQRT2 );
      if ( !(rnADU[c] > 0) )
         throw new Error( "The two bias frames are identical or contain no noise. " +
            "Please select two different raw bias frames." );
   }
   var biasRef = { name: b1.name, keywords: b1.keywords, width: w, height: h };
   b1.data = b2.data = null;

   // ---- 2. Conversion gain ------------------------------------------------
   var gain = NaN, gainPerChannel = null, gainSource = "";
   if ( p.gainMode == "flats" )
   {
      log( "Reading flat frames..." );
      var f1 = load( p.flat1 ), f2 = load( p.flat2 );
      secCheckSize( biasRef, f1 );
      secCheckSize( biasRef, f2 );
      secCheckKeyword( biasRef, f1, ["GAIN"], "gain", warnings );
      secCheckKeyword( biasRef, f1, ["OFFSET"], "offset", warnings );

      // central half of the frame, to stay away from vignetted corners
      var x0 = (w >> 2) & ~1, x1 = w - x0, y0 = (h >> 2) & ~1, y1 = h - y0;
      var hf1 = secHistograms( f1.data, w, layout, x0, y0, x1, y1 );
      var hf2 = secHistograms( f2.data, w, layout, x0, y0, x1, y1 );
      var hfd = secDiffHistograms( f1.data, f2.data, w, layout, x0, y0, x1, y1 );
      gainPerChannel = [];
      var good = [], usable = [];
      for ( var c1 = 0; c1 < nch; ++c1 )
      {
         var m1 = hf1[c1].moments( 0, SEC_ADU_MAX ).mean;
         var m2 = hf2[c1].moments( 0, SEC_ADU_MAX ).mean;
         var signal = 0.5*(m1 + m2) - biasLevel[c1];
         var sd = hfd[c1].clipped( 5 ).sd;
         var shotVar = 0.5*sd*sd - rnADU[c1]*rnADU[c1];
         var g = (signal > 0 && shotVar > 0) ? signal/shotVar : NaN;
         gainPerChannel.push( g );
         if ( Math.abs( m1 - m2 ) > 0.02*Math.max( m1, m2 ) )
            warnings.push( "Flat frames differ in brightness by more than 2% in channel " +
               layout.names[c1] + ". Use two flats taken back to back with a steady light source." );
         var bright = hf1[c1].quantile( 0.999 );
         if ( isFinite( g ) && bright < 0.9*SEC_ADU_MAX )
         {
            usable.push( g );
            if ( signal >= 1000 )
               good.push( g );
         }
         else if ( bright >= 0.9*SEC_ADU_MAX )
            warnings.push( "Flat channel " + layout.names[c1] + " is close to saturation and " +
               "was not used for the gain measurement." );
      }
      if ( good.length > 0 )
         gain = secMedianOf( good );
      else if ( usable.length > 0 )
      {
         gain = secMedianOf( usable );
         warnings.push( "The flat frames are faint (less than 1000 ADU above bias). The gain " +
            "measurement is less reliable. Aim for flats at about one third to one half of full scale." );
      }
      else
         throw new Error( "The conversion gain could not be measured from these flat frames. " +
            "Check that they are two different, unsaturated raw flats taken at the same gain " +
            "and offset as the bias frames, or enter the gain by hand." );
      gainSource = "measured from flats";
      f1.data = f2.data = null;
   }
   else
   {
      gain = p.manualGain;
      if ( !(gain > 0) )
         throw new Error( "Please enter a conversion gain greater than zero (e-/ADU)." );
      gainSource = "entered by hand";
   }

   var rnE = [], rnRmsE = [];
   for ( var c2 = 0; c2 < nch; ++c2 )
   {
      rnE.push( rnADU[c2]*gain );
      rnRmsE.push( rnRmsADU[c2]*gain );
   }

   var camera = {
      width: w, height: h, layout: layout, biasLevel: biasLevel, rnADU: rnADU, rnE: rnE,
      rnRmsADU: rnRmsADU, rnRmsE: rnRmsE,
      gain: gain, gainPerChannel: gainPerChannel, gainSource: gainSource,
      gainSetting: secKw( biasRef, ["GAIN"] ), offsetSetting: secKw( biasRef, ["OFFSET"] ),
      temperature: secKw( biasRef, ["SET-TEMP", "CCD-TEMP"] )
   };

   // ---- 3. Light frames ---------------------------------------------------
   var targets = p.targets;
   var frames = [];
   for ( var i = 0; i < p.lights.length; ++i )
   {
      log( "Reading light frame " + (i + 1) + " of " + p.lights.length + "..." );
      var L = load( p.lights[i] );
      secCheckSize( biasRef, L );
      secCheckKeyword( biasRef, L, ["GAIN"], "gain", warnings );
      secCheckKeyword( biasRef, L, ["OFFSET"], "offset", warnings );

      var exposure = secNum( secKw( L, ["EXPTIME", "EXPOSURE"] ) );
      if ( !(exposure > 0) )
         exposure = p.fallbackExposure;
      if ( !(exposure > 0) )
         throw new Error( L.name + " has no exposure time in its header. Enter it in the " +
            "\"Exposure if missing\" field." );

      var hl = secHistograms( L.data, w, layout, 0, 0, w, h );
      var med = [], mad = [];
      for ( var c3 = 0; c3 < nch; ++c3 )
      {
         med.push( hl[c3].median() );
         mad.push( hl[c3].mad() );
      }
      var bg = (p.bgMode == "tiles") ? secTileBackground( L.data, w, h, layout, med, 0.20 ) : med;

      var ch = [];
      for ( var c4 = 0; c4 < nch; ++c4 )
      {
         var skyADU = bg[c4] - biasLevel[c4];
         var skyE = skyADU*gain;
         var rn2 = rnE[c4]*rnE[c4];
         var valid = skyE > 0;
         // The median of a Poisson (skewed) signal sits slightly below its
         // mean, by about S/(6(S + R^2)) electrons. Correct for it.
         if ( valid )
         {
            skyE += skyE/(6*(skyE + rn2));
            skyADU = skyE/gain;
         }
         var rate = valid ? skyE/exposure : NaN;
         var mNow = valid ? skyE/rn2 : NaN;
         var times = [];
         for ( var t = 0; t < targets.length; ++t )
            times.push( valid ? targets[t]*rn2/rate : NaN );
         var predicted = Math.sqrt( rn2 + Math.max( 0, skyE ) );
         ch.push( {
            name: layout.names[c4], bgADU: bg[c4], skyADU: skyADU, skyE: skyE, rate: rate,
            m: mNow, efficiency: valid ? secEfficiency( mNow ) : NaN, times: times,
            noiseRatio: 1.4826*mad[c4]*gain/predicted,
            clippedPct: 100*(hl[c4].n - hl[c4].cdf( 0.98*SEC_ADU_MAX ))/Math.max( 1, hl[c4].n )
         } );
         if ( !valid )
            warnings.push( L.name + " channel " + layout.names[c4] + ": the background is not " +
               "above the bias level, so no sky rate can be measured. Use a longer test exposure." );
      }

      var dateObs = secKw( L, ["DATE-OBS"] );
      var ms = secParseDateObs( dateObs );
      var lat = secNum( secKw( L, ["SITELAT", "OBSGEO-B", "LAT-OBS"] ) );
      var lon = secNum( secKw( L, ["SITELONG", "OBSGEO-L", "LONG-OBS"] ) );
      if ( !isFinite( lat ) || !isFinite( lon ) )
      {
         lat = p.siteLat;
         lon = p.siteLon;
      }
      var sky = isFinite( ms ) ? secSkyInfo( (ms + 500*exposure)/86400000 + 2440587.5, lat, lon,
         secNum( secKw( L, ["RA"] ) ), secNum( secKw( L, ["DEC"] ) ) ) : null;

      frames.push( { name: L.name, filter: secKw( L, ["FILTER"] ) || "(none)", exposure: exposure,
                     dateObs: dateObs, sky: sky, channels: ch } );
      L.data = null;
   }

   // ---- 4. Summary per filter and channel (median over frames) -------------
   var groups = {}, order = [];
   for ( var f = 0; f < frames.length; ++f )
   {
      var key = frames[f].filter;
      if ( groups[key] === undefined )
      {
         groups[key] = [];
         order.push( key );
      }
      groups[key].push( frames[f] );
   }
   var summary = [];
   for ( var o = 0; o < order.length; ++o )
      for ( var c5 = 0; c5 < nch; ++c5 )
      {
         var rates = [], G = groups[order[o]];
         for ( var q = 0; q < G.length; ++q )
            if ( isFinite( G[q].channels[c5].rate ) )
               rates.push( G[q].channels[c5].rate );
         var r = secMedianOf( rates );
         var tt = [];
         for ( var t2 = 0; t2 < targets.length; ++t2 )
            tt.push( (r > 0) ? targets[t2]*rnE[c5]*rnE[c5]/r : NaN );
         summary.push( { filter: order[o], channel: layout.names[c5], frames: rates.length,
                         rate: r, times: tt } );
      }

   return { camera: camera, targets: targets, frames: frames, summary: summary, warnings: warnings };
}

// ============================================================================
// Reports
// ============================================================================

function secMoonText( sky )
{
   if ( sky == null )
      return "";
   var s = Math.round( 100*sky.moonIllum ) + "% " + (sky.moonWaxing ? "waxing" : "waning");
   if ( isFinite( sky.moonAlt ) )
      s += ", alt " + Math.round( sky.moonAlt ) + "°";
   if ( isFinite( sky.moonSep ) )
      s += ", sep " + Math.round( sky.moonSep ) + "°";
   return s;
}

function secCameraText( r )
{
   var cam = r.camera, n = cam.layout.names;
   function list( a, digits, unit )
   {
      var s = [];
      for ( var i = 0; i < a.length; ++i )
         s.push( (n.length > 1 ? n[i] + " " : "") + secFmt( a[i], digits ) );
      return s.join( " / " ) + " " + unit;
   }
   var lines = [];
   lines.push( "Sensor: " + (cam.layout.cfa ? "colour, Bayer pattern " + cam.layout.pattern : "mono") +
      ", " + cam.width + " x " + cam.height +
      (cam.gainSetting != "" ? ", gain " + cam.gainSetting : "") +
      (cam.offsetSetting != "" ? ", offset " + cam.offsetSetting : "") );
   lines.push( "Bias level: " + list( cam.biasLevel, 1, "ADU" ) );
   lines.push( "Read noise (typical pixel, used for the results): " + list( cam.rnE, 2, "e-" ) +
      "   (" + list( cam.rnADU, 2, "ADU" ) + ")" );
   lines.push( "Read noise (RMS of all pixels, including noisy outliers): " + list( cam.rnRmsE, 2, "e-" ) );
   lines.push( "Conversion gain: " + secFmt( cam.gain, 4 ) + " e-/ADU, " + cam.gainSource +
      (cam.gainPerChannel ? "   (per channel: " + list( cam.gainPerChannel, 4, "" ) + ")" : "") );
   return lines;
}

function secConsoleReport( r )
{
   var i, j, k;
   console.writeln( "<end><cbr><br><b>" + SEC_TITLE + " " + SEC_VERSION + "</b>" );
   var cam = secCameraText( r );
   for ( i = 0; i < cam.length; ++i )
      console.writeln( cam[i] );
   console.writeln( "" );
   for ( i = 0; i < r.frames.length; ++i )
   {
      var f = r.frames[i];
      console.writeln( "<b>" + f.name + "</b>  filter " + f.filter + ", " + f.exposure + " s" +
         (f.sky ? ", Moon " + secMoonText( f.sky ) : "") );
      for ( j = 0; j < f.channels.length; ++j )
      {
         var c = f.channels[j];
         var s = "   " + c.name + ": sky " + secFmt( c.skyADU, 1 ) + " ADU = " + secFmt( c.skyE, 2 ) +
            " e-, " + secFmt( c.rate, 4 ) + " e-/s, now " + secFmt( c.m, 1 ) + " x RN^2 (" +
            secFmt( 100*c.efficiency, 1 ) + "%).";
         for ( k = 0; k < r.targets.length; ++k )
            s += "  " + r.targets[k] + "x: " + secFmtTime( c.times[k] );
         console.writeln( s );
      }
   }
   if ( r.warnings.length > 0 )
   {
      console.writeln( "" );
      for ( i = 0; i < r.warnings.length; ++i )
         console.warningln( "Warning: " + r.warnings[i] );
   }
   console.flush();
}

function secCsvReport( r )
{
   var head = ["file", "filter", "exposure_s", "date_obs", "channel", "background_ADU", "bias_ADU",
      "sky_ADU", "sky_e", "sky_rate_e_per_s", "read_noise_e", "read_noise_rms_all_pixels_e", "gain_e_per_ADU", "multiple_now",
      "efficiency_now_pct"];
   var k;
   for ( k = 0; k < r.targets.length; ++k )
      head.push( "t_" + r.targets[k] + "x_s" );
   head = head.concat( ["noise_measured_over_predicted", "clipped_pct", "moon_illum_pct",
      "moon_phase", "moon_alt_deg", "moon_sep_deg", "sun_alt_deg", "target_alt_deg"] );
   var out = head.join( "," ) + "\n";
   for ( var i = 0; i < r.frames.length; ++i )
   {
      var f = r.frames[i];
      for ( var j = 0; j < f.channels.length; ++j )
      {
         var c = f.channels[j];
         var row = [f.name, f.filter, f.exposure, f.dateObs, c.name, secFmt( c.bgADU, 2 ),
            secFmt( r.camera.biasLevel[j], 2 ), secFmt( c.skyADU, 2 ), secFmt( c.skyE, 3 ),
            secFmt( c.rate, 5 ), secFmt( r.camera.rnE[j], 3 ), secFmt( r.camera.rnRmsE[j], 3 ),
            secFmt( r.camera.gain, 4 ),
            secFmt( c.m, 2 ), secFmt( 100*c.efficiency, 1 )];
         for ( k = 0; k < r.targets.length; ++k )
            row.push( secFmt( c.times[k], 0 ) );
         row.push( secFmt( c.noiseRatio, 2 ), secFmt( c.clippedPct, 3 ) );
         if ( f.sky )
            row.push( secFmt( 100*f.sky.moonIllum, 0 ), f.sky.moonWaxing ? "waxing" : "waning",
               secFmt( f.sky.moonAlt, 0 ), secFmt( f.sky.moonSep, 0 ), secFmt( f.sky.sunAlt, 0 ),
               secFmt( f.sky.targetAlt, 0 ) );
         else
            row.push( "", "", "", "", "", "" );
         for ( var q = 0; q < row.length; ++q )
            row[q] = secCsv( row[q] == "n/a" ? "" : row[q] );
         out += row.join( "," ) + "\n";
      }
   }
   return out;
}

// ============================================================================
// Help
// ============================================================================

var SEC_HELP = [
   { title: "1. What this tool does", html:
      "<p><b>What this tool does</b></p>" +
      "<p>Every sub-exposure carries a fixed dose of <i>read noise</i>, added once when the " +
      "sensor is read out. Everything else that is noisy in your image (the sky background, the " +
      "target itself, dark current) grows with exposure time. If each sub is long enough for the " +
      "sky background to bury the read noise, splitting your night into subs costs you almost " +
      "nothing compared with one impossibly long exposure.</p>" +
      "<p>This tool measures the three numbers that decide where that point lies for <i>your</i> " +
      "camera, filter and sky:</p>" +
      "<ul><li>the read noise of your camera at the gain you use,</li>" +
      "<li>the conversion gain (how many electrons one ADU stands for),</li>" +
      "<li>the rate at which the sky background fills a pixel through each filter.</li></ul>" +
      "<p>It then reports how long a sub must be to reach a chosen level of efficiency. Nothing is " +
      "written to your frames and no images are left open.</p>" },
   { title: "2. Frames you need", html:
      "<p><b>Frames you need</b></p>" +
      "<p>All frames must be <b>raw</b>: straight from the camera, not calibrated, not debayered, " +
      "not stacked. They must share the same gain, offset, binning and (ideally) sensor " +
      "temperature.</p>" +
      "<p><b>Two bias frames.</b> Shortest possible exposure, sensor covered. Two <i>single</i> " +
      "frames, not a master: stacking averages the noise away, which is exactly what we want to " +
      "measure.</p>" +
      "<p><b>Two flat frames (optional).</b> Two flats taken back to back with a steady light " +
      "source, somewhere between a third and a half of full scale. They are used to measure the " +
      "conversion gain. Any filter will do, since the gain belongs to the camera. If you have no " +
      "flats, type the e-/ADU value from the manufacturer's chart instead.</p>" +
      "<p><b>One or more light frames.</b> Ordinary subs of any target, one or several per filter. " +
      "The exposure time and filter name are read from the FITS header.</p>" },
   { title: "3. Step by step", html:
      "<p><b>Step by step</b></p>" +
      "<ol><li>Select the two bias frames.</li>" +
      "<li>Choose how to obtain the conversion gain: measure it from two flats, or enter it.</li>" +
      "<li>Add your light frames. Mix filters freely; results are grouped by filter.</li>" +
      "<li>Leave <i>Sensor</i> on Auto unless your files lack a BAYERPAT keyword. A colour sensor " +
      "is then recognised by that keyword; anything else is treated as mono.</li>" +
      "<li>Choose the multiples of read noise squared you want times for (3, 5 and 10 by default).</li>" +
      "<li>Press <b>Calculate</b>. Results appear in the table and, in more detail, in the Process " +
      "Console.</li>" +
      "<li>Press <b>Save CSV</b> to keep the results, for example to build a table of sky " +
      "brightness against Moon phase over several nights.</li></ol>" +
      "<p>For a colour camera no debayering is done. The red, green and blue pixels are simply " +
      "measured separately, so no interpolation touches the numbers. The two green positions are " +
      "pooled.</p>" },
   { title: "4. The theory", html:
      "<p><b>The theory</b></p>" +
      "<p>Call the read noise <i>R</i> (electrons) and the sky background collected in one sub " +
      "<i>S</i> (electrons). Shot noise from the sky is &radic;S, so the background noise of one sub " +
      "is &radic;(S + R<sup>2</sup>). A single exposure as long as your whole stack would contain " +
      "the same sky signal but only one dose of read noise, which is negligible. Comparing the two " +
      "gives the <b>efficiency</b> of stacking:</p>" +
      "<p align=\"center\">efficiency = &radic;( m / (m + 1) ), &nbsp; where &nbsp; m = S / R<sup>2</sup></p>" +
      "<p>So <i>m</i> says how many times the sky signal exceeds the read noise squared:</p>" +
      "<ul><li>m = 3 gives 87% of the ideal signal-to-noise ratio,</li>" +
      "<li>m = 5 gives 91%,</li><li>m = 10 gives 95%,</li><li>m = 50 gives 99%.</li></ul>" +
      "<p>If the sky delivers <i>P</i> electrons per second per pixel, the sub length that reaches " +
      "a chosen <i>m</i> is</p>" +
      "<p align=\"center\">t = m &times; R<sup>2</sup> / P</p>" +
      "<p>There is no single optimum. Returns diminish quickly, total integration time matters far " +
      "more than sub length, and very long subs cost dynamic range and are lost more easily to " +
      "wind, clouds, satellites and guiding errors.</p>" },
   { title: "5. How the measurements are made", html:
      "<p><b>How the measurements are made</b></p>" +
      "<p><b>Bias level.</b> The median of the bias frames, per channel. It is the pedestal that " +
      "must be removed before ADU can be turned into electrons.</p>" +
      "<p><b>Read noise.</b> One bias frame is subtracted from the other. Fixed pattern cancels and " +
      "only random noise remains, from two frames. Its standard deviation divided by &radic;2 is " +
      "the read noise of one frame in ADU. Two figures are shown. The <i>typical pixel</i> value " +
      "ignores outliers beyond 5 sigma and is used for the results. The <i>RMS of all pixels</i> " +
      "includes the small share of noisy pixels every CMOS sensor has, and is closer to what " +
      "manufacturers publish. If they differ a lot, the truth for your faintest detail lies " +
      "between them.</p>" +
      "<p><b>Conversion gain.</b> Light obeys Poisson statistics: in electrons, variance equals " +
      "signal. Subtracting two flats removes dust and vignetting and leaves shot noise plus read " +
      "noise. Gain = (flat level above bias) / (shot noise variance in ADU). Only the central part " +
      "of the frame is used.</p>" +
      "<p><b>Sky background.</b> With <i>Darkest tiles</i>, the frame is cut into a grid, the median " +
      "of every tile is taken, and the 20th percentile of those medians is used. That finds empty " +
      "sky even when a nebula fills much of the frame. <i>Whole frame median</i> is the simple " +
      "alternative for sparse fields.</p>" +
      "<p>Sky electrons = (background &minus; bias level) &times; gain. Divided by the exposure " +
      "time this is the sky rate <i>P</i>.</p>" },
   { title: "6. Reading the results", html:
      "<p><b>Reading the results</b></p>" +
      "<ul><li><b>Sky (ADU), Sky (e-)</b>: background above the bias level in this frame.</li>" +
      "<li><b>Rate</b>: sky electrons per second per pixel. This is the number worth logging " +
      "against Moon phase.</li>" +
      "<li><b>m now, Eff.</b>: where this frame's exposure time already puts you.</li>" +
      "<li><b>t (m = ...)</b>: sub length needed to reach each chosen multiple.</li>" +
      "<li><b>Noise check</b>: measured background noise divided by the noise predicted from read " +
      "noise and sky. Close to 1.0 means bias level, gain and read noise are consistent. Clearly " +
      "above 1 points to nebulosity, gradients or a wrong gain.</li>" +
      "<li><b>Moon</b>: illuminated fraction from the frame's date. Altitude and separation from " +
      "the target appear when the site and target coordinates are known.</li></ul>" +
      "<p>With a dual-band filter on a colour camera, H-alpha and SII land in R, while OIII and " +
      "H-beta land in G and B. The channels will ask for different times. Choose the channel you " +
      "care about most, or a compromise.</p>" },
   { title: "7. Practical advice and limits", html:
      "<p><b>Practical advice and limits</b></p>" +
      "<ul><li>Narrowband results often run to many minutes. If your mount, wind or satellites " +
      "limit you to shorter subs, use them. Dropping from m = 10 to m = 3 costs only about 8% in " +
      "signal-to-noise ratio.</li>" +
      "<li>Do not avoid a narrower filter because the calculated time is long. It lowers the sky " +
      "noise by more than the loss in efficiency.</li>" +
      "<li>Under bright skies the calculated time can be very short. Longer subs are fine as long " +
      "as stars and bright cores are not clipped.</li>" +
      "<li>The sky rate changes with Moon phase, Moon altitude and distance, target altitude and " +
      "transparency. Measure again when conditions change.</li>" +
      "<li>Dark current is not removed. For cooled cameras it is negligible. For warm sensors, " +
      "use two darks of matching exposure in place of the bias frames to remove its level; the " +
      "reported read noise then includes dark noise.</li>" +
      "<li>The Bayer pattern is taken as stored in the file. If colours look swapped, set the " +
      "pattern by hand.</li></ul>" +
      "<p>Further reading: Charles Bracken, <i>The Deep-sky Imaging Primer</i>, chapter on setting " +
      "exposure parameters, which inspired this tool.</p>" }
];

function SecHelpDialog()
{
   this.__base__ = Dialog;
   this.__base__();
   var self = this;
   this.windowTitle = SEC_TITLE + " Help";

   this.topic = new ComboBox( this );
   for ( var i = 0; i < SEC_HELP.length; ++i )
      this.topic.addItem( SEC_HELP[i].title );

   this.page = new Label( this );
   this.page.frameStyle = FrameStyle_Box;
   this.page.margin = 10;
   this.page.wordWrapping = true;
   this.page.useRichText = true;
   this.page.setScaledMinSize( 680, 420 );
   this.page.text = SEC_HELP[0].html;

   this.topic.onItemSelected = function( index )
   {
      self.page.text = SEC_HELP[index].html;
   };

   this.prev = new PushButton( this );
   this.prev.text = "Previous";
   this.prev.onClick = function()
   {
      var k = Math.max( 0, self.topic.currentItem - 1 );
      self.topic.currentItem = k;
      self.page.text = SEC_HELP[k].html;
   };
   this.next = new PushButton( this );
   this.next.text = "Next";
   this.next.onClick = function()
   {
      var k = Math.min( SEC_HELP.length - 1, self.topic.currentItem + 1 );
      self.topic.currentItem = k;
      self.page.text = SEC_HELP[k].html;
   };
   this.closeButton = new PushButton( this );
   this.closeButton.text = "Close";
   this.closeButton.onClick = function() { self.ok(); };

   var buttons = new HorizontalSizer;
   buttons.spacing = 6;
   buttons.add( this.prev );
   buttons.add( this.next );
   buttons.addStretch();
   buttons.add( this.closeButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( this.topic );
   this.sizer.add( this.page, 100 );
   this.sizer.add( buttons );
   this.adjustToContents();
}
SecHelpDialog.prototype = new Dialog;

// ============================================================================
// Main dialog
// ============================================================================

var SEC_FILE_FILTERS = [["Raw frames", "*.fit", "*.fits", "*.fts", "*.xisf"], ["All files", "*"]];
var SEC_SENSORS = ["auto", "mono", "RGGB", "BGGR", "GRBG", "GBRG"];
var SEC_SENSOR_LABELS = ["Auto (from BAYERPAT keyword)", "Mono", "Colour RGGB", "Colour BGGR",
                         "Colour GRBG", "Colour GBRG"];

function secLoadSetting( key, def )
{
   try
   {
      var v = Settings.read( SEC_TITLE + "/" + key, DataType_String );
      if ( Settings.lastReadOK && v !== null && v !== undefined )
         return String( v );
   }
   catch ( e ) {}
   return def;
}

function secSaveSetting( key, value )
{
   try { Settings.write( SEC_TITLE + "/" + key, DataType_String, String( value ) ); } catch ( e ) {}
}

function SecDialog()
{
   this.__base__ = Dialog;
   this.__base__();
   var self = this;
   this.windowTitle = SEC_TITLE + " " + SEC_VERSION;
   this.lightPaths = [];
   this.results = null;

   var labelWidth = this.font.width( "Site longitude (°, east +):" ) + 12;

   function makeLabel( text )
   {
      var l = new Label( self );
      l.text = text;
      l.textAlignment = TextAlign_Right | TextAlign_VertCenter;
      l.setFixedWidth( labelWidth );
      return l;
   }

   function makeFileRow( text, key, caption )
   {
      var edit = new Edit( self );
      edit.text = secLoadSetting( key, "" );
      var button = new PushButton( self );
      button.text = "Select...";
      button.onClick = function()
      {
         var d = new OpenFileDialog;
         d.caption = caption;
         d.filters = SEC_FILE_FILTERS;
         if ( d.execute() )
            edit.text = d.fileName;
      };
      var s = new HorizontalSizer;
      s.spacing = 6;
      var label = makeLabel( text );
      s.add( label );
      s.add( edit, 100 );
      s.add( button );
      return { sizer: s, edit: edit, button: button, label: label };
   }

   function makeEditRow( text, key, def, toolTip )
   {
      var edit = new Edit( self );
      edit.text = secLoadSetting( key, def );
      edit.setFixedWidth( self.font.width( "0000000000000000" ) );
      edit.toolTip = toolTip;
      var s = new HorizontalSizer;
      s.spacing = 6;
      var label = makeLabel( text );
      label.toolTip = toolTip;
      s.add( label );
      s.add( edit );
      s.addStretch();
      return { sizer: s, edit: edit, label: label };
   }

   // ---- Header ----
   this.header = new Label( this );
   this.header.frameStyle = FrameStyle_Box;
   this.header.margin = 6;
   this.header.wordWrapping = true;
   this.header.useRichText = true;
   this.header.text = "<p><b>" + SEC_TITLE + "</b> measures your camera's read noise and gain and " +
      "your sky background from <b>raw</b> frames, and calculates how long a sub-exposure must be " +
      "to make read noise insignificant. Follow steps 1 to 4, then press Calculate. " +
      "Press Help for the method and the theory.</p>";

   // ---- Step 1: bias ----
   this.bias1 = makeFileRow( "Bias frame 1:", "bias1", "Select the first raw bias frame" );
   this.bias2 = makeFileRow( "Bias frame 2:", "bias2", "Select the second raw bias frame" );
   this.biasGroup = new GroupBox( this );
   this.biasGroup.title = "Step 1: two single raw bias frames (not a master)";
   this.biasGroup.sizer = new VerticalSizer;
   this.biasGroup.sizer.margin = 6;
   this.biasGroup.sizer.spacing = 4;
   this.biasGroup.sizer.add( this.bias1.sizer );
   this.biasGroup.sizer.add( this.bias2.sizer );

   // ---- Step 2: gain ----
   this.gainMode = new ComboBox( this );
   this.gainMode.addItem( "Measure from two raw flat frames" );
   this.gainMode.addItem( "Enter a value" );
   this.gainMode.currentItem = (secLoadSetting( "gainMode", "manual" ) == "flats") ? 0 : 1;
   var gainModeRow = new HorizontalSizer;
   gainModeRow.spacing = 6;
   gainModeRow.add( makeLabel( "Conversion gain:" ) );
   gainModeRow.add( this.gainMode );
   gainModeRow.addStretch();

   this.flat1 = makeFileRow( "Flat frame 1:", "flat1", "Select the first raw flat frame" );
   this.flat2 = makeFileRow( "Flat frame 2:", "flat2", "Select the second raw flat frame" );
   this.manualGain = makeEditRow( "Gain (e-/ADU):", "manualGain", "0.25",
      "Electrons per ADU on the 16 bit scale at the gain setting you use, from the " +
      "manufacturer's chart or a sensor analysis." );

   this.updateGainMode = function()
   {
      var flats = self.gainMode.currentItem == 0;
      self.flat1.edit.enabled = self.flat1.button.enabled = flats;
      self.flat2.edit.enabled = self.flat2.button.enabled = flats;
      self.manualGain.edit.enabled = !flats;
   };
   this.gainMode.onItemSelected = function() { self.updateGainMode(); };
   this.updateGainMode();

   this.gainGroup = new GroupBox( this );
   this.gainGroup.title = "Step 2: conversion gain";
   this.gainGroup.sizer = new VerticalSizer;
   this.gainGroup.sizer.margin = 6;
   this.gainGroup.sizer.spacing = 4;
   this.gainGroup.sizer.add( gainModeRow );
   this.gainGroup.sizer.add( this.flat1.sizer );
   this.gainGroup.sizer.add( this.flat2.sizer );
   this.gainGroup.sizer.add( this.manualGain.sizer );

   // ---- Step 3: lights ----
   this.lightsTree = new TreeBox( this );
   this.lightsTree.alternateRowColor = true;
   this.lightsTree.rootDecoration = false;
   this.lightsTree.multipleSelection = true;
   this.lightsTree.numberOfColumns = 1;
   this.lightsTree.headerVisible = false;
   this.lightsTree.setScaledMinSize( 640, 90 );

   this.refreshLights = function()
   {
      self.lightsTree.clear();
      for ( var i = 0; i < self.lightPaths.length; ++i )
      {
         var node = new TreeBoxNode( self.lightsTree );
         node.setText( 0, self.lightPaths[i] );
      }
   };

   this.addLights = new PushButton( this );
   this.addLights.text = "Add...";
   this.addLights.onClick = function()
   {
      var d = new OpenFileDialog;
      d.multipleSelections = true;
      d.caption = "Select raw light frames";
      d.filters = SEC_FILE_FILTERS;
      if ( d.execute() )
      {
         var names = d.fileNames;
         for ( var i = 0; i < names.length; ++i )
            if ( self.lightPaths.indexOf( names[i] ) < 0 )
               self.lightPaths.push( names[i] );
         self.refreshLights();
      }
   };
   this.removeLights = new PushButton( this );
   this.removeLights.text = "Remove";
   this.removeLights.onClick = function()
   {
      var sel = self.lightsTree.selectedNodes, idx = [];
      for ( var i = 0; i < sel.length; ++i )
         idx.push( self.lightsTree.childIndex( sel[i] ) );
      idx.sort( function( a, b ) { return b - a; } );
      for ( var j = 0; j < idx.length; ++j )
         if ( idx[j] >= 0 )
            self.lightPaths.splice( idx[j], 1 );
      self.refreshLights();
   };
   this.clearLights = new PushButton( this );
   this.clearLights.text = "Clear";
   this.clearLights.onClick = function()
   {
      self.lightPaths = [];
      self.refreshLights();
   };
   var lightButtons = new VerticalSizer;
   lightButtons.spacing = 4;
   lightButtons.add( this.addLights );
   lightButtons.add( this.removeLights );
   lightButtons.add( this.clearLights );
   lightButtons.addStretch();

   this.lightsGroup = new GroupBox( this );
   this.lightsGroup.title = "Step 3: raw light frames (uncalibrated, one or more per filter)";
   this.lightsGroup.sizer = new HorizontalSizer;
   this.lightsGroup.sizer.margin = 6;
   this.lightsGroup.sizer.spacing = 6;
   this.lightsGroup.sizer.add( this.lightsTree, 100 );
   this.lightsGroup.sizer.add( lightButtons );

   // ---- Step 4: options ----
   this.sensor = new ComboBox( this );
   for ( var s = 0; s < SEC_SENSOR_LABELS.length; ++s )
      this.sensor.addItem( SEC_SENSOR_LABELS[s] );
   this.sensor.currentItem = Math.max( 0, SEC_SENSORS.indexOf( secLoadSetting( "sensor", "auto" ) ) );
   var sensorRow = new HorizontalSizer;
   sensorRow.spacing = 6;
   sensorRow.add( makeLabel( "Sensor:" ) );
   sensorRow.add( this.sensor );
   sensorRow.addStretch();

   this.bgMode = new ComboBox( this );
   this.bgMode.addItem( "Darkest tiles (copes with nebulosity)" );
   this.bgMode.addItem( "Whole frame median" );
   this.bgMode.currentItem = (secLoadSetting( "bgMode", "tiles" ) == "frame") ? 1 : 0;
   var bgRow = new HorizontalSizer;
   bgRow.spacing = 6;
   bgRow.add( makeLabel( "Sky background:" ) );
   bgRow.add( this.bgMode );
   bgRow.addStretch();

   this.targets = makeEditRow( "Target multiples:", "targets", "3, 5, 10",
      "Multiples of read noise squared to calculate sub-exposure times for, separated by commas. " +
      "3 gives 87%, 5 gives 91% and 10 gives 95% of the ideal signal-to-noise ratio." );
   this.fallback = makeEditRow( "Exposure if missing (s):", "fallback", "",
      "Used only for light frames whose header has no EXPTIME or EXPOSURE keyword." );
   this.siteLat = makeEditRow( "Site latitude (°, north +):", "siteLat", "",
      "Optional. Used for Moon altitude when the frames have no SITELAT keyword." );
   this.siteLon = makeEditRow( "Site longitude (°, east +):", "siteLon", "",
      "Optional. Used for Moon altitude when the frames have no SITELONG keyword." );

   var optLeft = new VerticalSizer;
   optLeft.spacing = 4;
   optLeft.add( sensorRow );
   optLeft.add( bgRow );
   optLeft.add( this.targets.sizer );
   var optRight = new VerticalSizer;
   optRight.spacing = 4;
   optRight.add( this.fallback.sizer );
   optRight.add( this.siteLat.sizer );
   optRight.add( this.siteLon.sizer );

   this.optionsGroup = new GroupBox( this );
   this.optionsGroup.title = "Step 4: options";
   this.optionsGroup.sizer = new HorizontalSizer;
   this.optionsGroup.sizer.margin = 6;
   this.optionsGroup.sizer.spacing = 12;
   this.optionsGroup.sizer.add( optLeft );
   this.optionsGroup.sizer.add( optRight );
   this.optionsGroup.sizer.addStretch();

   // ---- Results ----
   this.cameraLabel = new Label( this );
   this.cameraLabel.wordWrapping = true;
   this.cameraLabel.text = "Results appear here after you press Calculate.";

   this.resultsTree = new TreeBox( this );
   this.resultsTree.alternateRowColor = true;
   this.resultsTree.rootDecoration = false;
   this.resultsTree.numberOfColumns = 1;
   this.resultsTree.headerVisible = true;
   this.resultsTree.setHeaderText( 0, "Results" );
   this.resultsTree.setScaledMinSize( 860, 190 );

   this.resultsGroup = new GroupBox( this );
   this.resultsGroup.title = "Results";
   this.resultsGroup.sizer = new VerticalSizer;
   this.resultsGroup.sizer.margin = 6;
   this.resultsGroup.sizer.spacing = 4;
   this.resultsGroup.sizer.add( this.cameraLabel );
   this.resultsGroup.sizer.add( this.resultsTree, 100 );

   // ---- Buttons ----
   this.helpButton = new PushButton( this );
   this.helpButton.text = "Help";
   this.helpButton.onClick = function() { (new SecHelpDialog).execute(); };

   this.calcButton = new PushButton( this );
   this.calcButton.text = "Calculate";
   this.calcButton.defaultButton = true;
   this.calcButton.onClick = function() { self.calculate(); };

   this.csvButton = new PushButton( this );
   this.csvButton.text = "Save CSV...";
   this.csvButton.enabled = false;
   this.csvButton.onClick = function()
   {
      if ( self.results == null )
         return;
      var d = new SaveFileDialog;
      d.caption = "Save results as CSV";
      d.filters = [["CSV files", "*.csv"]];
      if ( d.execute() )
      {
         var path = d.fileName;
         if ( !/\.csv$/i.test( path ) )
            path += ".csv";
         File.writeTextFile( path, secCsvReport( self.results ) );
         console.writeln( "Results saved to " + path );
      }
   };

   this.closeButton = new PushButton( this );
   this.closeButton.text = "Close";
   this.closeButton.onClick = function() { self.ok(); };

   var buttons = new HorizontalSizer;
   buttons.spacing = 6;
   buttons.add( this.helpButton );
   buttons.addStretch();
   buttons.add( this.calcButton );
   buttons.add( this.csvButton );
   buttons.add( this.closeButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( this.header );
   this.sizer.add( this.biasGroup );
   this.sizer.add( this.gainGroup );
   this.sizer.add( this.lightsGroup );
   this.sizer.add( this.optionsGroup );
   this.sizer.add( this.resultsGroup, 100 );
   this.sizer.add( buttons );
   this.adjustToContents();

   // ---- Actions ----
   this.fail = function( message )
   {
      (new MessageBox( message, SEC_TITLE, StdIcon_Error, StdButton_Ok )).execute();
   };

   this.calculate = function()
   {
      var p = {
         bias1: secTrim( self.bias1.edit.text ),
         bias2: secTrim( self.bias2.edit.text ),
         gainMode: (self.gainMode.currentItem == 0) ? "flats" : "manual",
         flat1: secTrim( self.flat1.edit.text ),
         flat2: secTrim( self.flat2.edit.text ),
         manualGain: parseFloat( self.manualGain.edit.text.replace( ",", "." ) ),
         lights: self.lightPaths.slice( 0 ),
         sensor: SEC_SENSORS[self.sensor.currentItem],
         bgMode: (self.bgMode.currentItem == 0) ? "tiles" : "frame",
         targets: [],
         fallbackExposure: parseFloat( self.fallback.edit.text.replace( ",", "." ) ),
         siteLat: parseFloat( self.siteLat.edit.text.replace( ",", "." ) ),
         siteLon: parseFloat( self.siteLon.edit.text.replace( ",", "." ) )
      };
      var parts = self.targets.edit.text.split( /[,;\s]+/ );
      for ( var i = 0; i < parts.length; ++i )
      {
         var v = parseFloat( parts[i] );
         if ( v > 0 )
            p.targets.push( v );
      }

      if ( p.bias1 == "" || p.bias2 == "" )
         return self.fail( "Step 1: please select two raw bias frames." );
      if ( p.bias1 == p.bias2 )
         return self.fail( "Step 1: the two bias frames must be two different files." );
      if ( p.gainMode == "flats" && (p.flat1 == "" || p.flat2 == "" || p.flat1 == p.flat2) )
         return self.fail( "Step 2: please select two different raw flat frames, or choose " +
            "\"Enter a value\"." );
      if ( p.gainMode == "manual" && !(p.manualGain > 0) )
         return self.fail( "Step 2: please enter the conversion gain in e-/ADU." );
      if ( p.lights.length == 0 )
         return self.fail( "Step 3: please add at least one raw light frame." );
      if ( p.targets.length == 0 )
         return self.fail( "Step 4: please enter at least one target multiple, for example 3, 5, 10." );

      secSaveSetting( "bias1", p.bias1 );
      secSaveSetting( "bias2", p.bias2 );
      secSaveSetting( "flat1", p.flat1 );
      secSaveSetting( "flat2", p.flat2 );
      secSaveSetting( "gainMode", p.gainMode );
      secSaveSetting( "manualGain", self.manualGain.edit.text );
      secSaveSetting( "sensor", p.sensor );
      secSaveSetting( "bgMode", p.bgMode );
      secSaveSetting( "targets", self.targets.edit.text );
      secSaveSetting( "fallback", self.fallback.edit.text );
      secSaveSetting( "siteLat", self.siteLat.edit.text );
      secSaveSetting( "siteLon", self.siteLon.edit.text );

      self.cameraLabel.text = "Working...";
      processEvents();
      var r = null;
      try
      {
         r = secCompute( p, function( message )
         {
            console.writeln( message );
            console.flush();
            self.cameraLabel.text = message;
            processEvents();
         } );
      }
      catch ( e )
      {
         self.cameraLabel.text = "The calculation stopped with an error.";
         return self.fail( String( e.message || e ) );
      }

      self.results = r;
      self.csvButton.enabled = true;
      secConsoleReport( r );
      self.showResults( r );
   };

   this.showResults = function( r )
   {
      var lines = secCameraText( r );
      if ( r.warnings.length > 0 )
         lines.push( r.warnings.length + " warning(s), see the Process Console. First: " + r.warnings[0] );
      self.cameraLabel.text = lines.join( "\n" );

      var head = ["Frame", "Filter", "Exp (s)", "Ch", "Sky (ADU)", "Sky (e-)", "Rate (e-/s)",
                  "m now", "Eff."];
      var k;
      for ( k = 0; k < r.targets.length; ++k )
         head.push( "t (m=" + r.targets[k] + ")" );
      head.push( "Noise check", "Moon" );

      var tree = self.resultsTree;
      tree.clear();
      tree.numberOfColumns = head.length;
      for ( k = 0; k < head.length; ++k )
         tree.setHeaderText( k, head[k] );

      function addRow( cells )
      {
         var node = new TreeBoxNode( tree );
         for ( var q = 0; q < cells.length; ++q )
            node.setText( q, String( cells[q] ) );
      }

      for ( var i = 0; i < r.frames.length; ++i )
      {
         var f = r.frames[i];
         for ( var j = 0; j < f.channels.length; ++j )
         {
            var c = f.channels[j];
            var row = [(j == 0) ? f.name : "", f.filter, f.exposure, c.name, secFmt( c.skyADU, 1 ),
               secFmt( c.skyE, 2 ), secFmt( c.rate, 4 ), secFmt( c.m, 1 ),
               isFinite( c.efficiency ) ? secFmt( 100*c.efficiency, 1 ) + "%" : "n/a"];
            for ( k = 0; k < r.targets.length; ++k )
               row.push( secFmtTime( c.times[k] ) );
            row.push( secFmt( c.noiseRatio, 2 ), (j == 0) ? secMoonText( f.sky ) : "" );
            addRow( row );
         }
      }

      for ( var u = 0; u < r.summary.length; ++u )
      {
         var sm = r.summary[u];
         if ( sm.frames < 2 )
            continue; // a median of one frame only repeats the row above
         var srow = ["MEDIAN of " + sm.frames + " frame(s)", sm.filter, "", sm.channel, "", "",
                     secFmt( sm.rate, 4 ), "", ""];
         for ( k = 0; k < r.targets.length; ++k )
            srow.push( secFmtTime( sm.times[k] ) );
         srow.push( "", "" );
         addRow( srow );
      }

      for ( k = 0; k < head.length; ++k )
         tree.adjustColumnWidthToContents( k );
   };
}
SecDialog.prototype = new Dialog;

function main()
{
   console.show();
   console.writeln( "<end><cbr><br><b>" + SEC_TITLE + " " + SEC_VERSION + "</b>" );
   (new SecDialog).execute();
}

if ( typeof ImageWindow != "undefined" )
   main();
