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
#include <pjsr/PenStyle.jsh>

var SEC_TITLE = "SubExposureCalculator";
var SEC_VERSION = "1.0.2";
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

// A round sub length: "90 s", "3 min", "2.5 min", "1.5 h".
function secFmtNice( seconds )
{
   if ( !isFinite( seconds ) || seconds <= 0 )
      return "n/a";
   if ( seconds < 120 )
      return Math.round( seconds ) + " s";
   if ( seconds < 5400 )
      return String( Math.round( seconds/6 )/10 ) + " min";
   return String( Math.round( seconds/360 )/10 ) + " h";
}

// Makes a string safe to show in a rich text label.
function secHtml( s )
{
   return String( s ).replace( /&/g, "&amp;" ).replace( /</g, "&lt;" ).replace( />/g, "&gt;" );
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
   if ( !(s >= 1) )
      s = 1; // never start narrower than one ADU, or coarse data clips itself away
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
 * Cameras with fewer than 16 bits usually deliver their values shifted up to
 * the 16 bit range: a 12 bit camera then only produces multiples of 16, a
 * 14 bit camera multiples of 4. This returns the number of bits by which the
 * values of the given frames are shifted, 0 for genuine 16 bit data (and for
 * low bit depth data stored unscaled).
 */
function secDataShift( a, b )
{
   var bits = 0, i, n;
   for ( i = 0, n = a.length; i < n; ++i )
      bits |= a[i];
   for ( i = 0, n = b.length; i < n; ++i )
      bits |= b[i];
   var shift = 0;
   while ( bits != 0 && (bits & 1) == 0 && shift < 8 )
   {
      bits >>= 1;
      ++shift;
   }
   return shift;
}

/*
 * Converts a frame to the camera's own ADU steps by removing the shift, so
 * that statistics see consecutive integers. Returns the number of pixels whose
 * value was not a whole number of steps.
 */
function secShiftData( data, shift )
{
   if ( shift == 0 )
      return 0;
   var mask = (1 << shift) - 1, odd = 0;
   for ( var i = 0, n = data.length; i < n; ++i )
   {
      var v = data[i];
      if ( v & mask )
         ++odd;
      data[i] = v >> shift;
   }
   return odd;
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

// Sub lengths people actually set in a capture program, in seconds.
var SEC_NICE_TIMES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 45, 50, 60, 75, 90, 120,
                      150, 180, 210, 240, 300, 360, 420, 480, 540, 600, 720, 900, 1200, 1500, 1800,
                      2400, 3000, 3600];

/*
 * Rounds a calculated time to a common sub length: the first one that is not
 * more than 5% shorter than the calculated time. At m = 5, being 5% short
 * costs under half a percent in efficiency.
 */
function secNiceTime( seconds )
{
   if ( !isFinite( seconds ) || !(seconds > 0) )
      return NaN;
   for ( var i = 0; i < SEC_NICE_TIMES.length; ++i )
      if ( SEC_NICE_TIMES[i] >= 0.95*seconds )
         return SEC_NICE_TIMES[i];
   return 600*Math.ceil( 0.95*seconds/600 ); // beyond an hour: whole 10 minutes
}

/*
 * The sub-exposure for one filter and one set of read noise figures.
 *
 * rates[] (sky electrons per second) and rn[] (read noise) are per channel,
 * sorted[] are the target multiples in ascending order. A colour camera takes
 * one exposure for all three channels, so the channel whose sky builds up most
 * slowly against its read noise sets the time: when that one reaches the
 * chosen multiple, the others are above it.
 */
function secSuggestFor( names, rates, rn, sorted, goal )
{
   var ch = [], slow = -1, fast = -1, c;
   for ( c = 0; c < names.length; ++c )
   {
      // multiples of read noise squared gained per second
      var k = (rates[c] > 0 && rn[c] > 0) ? rates[c]/(rn[c]*rn[c]) : NaN;
      ch.push( { name: names[c], rate: rates[c], perSecond: k, m: NaN, efficiency: NaN } );
      if ( isFinite( k ) )
      {
         if ( slow < 0 || k < ch[slow].perSecond )
            slow = c;
         if ( fast < 0 || k > ch[fast].perSecond )
            fast = c;
      }
   }
   if ( slow < 0 )
      return null;

   var kSlow = ch[slow].perSecond;
   var times = [];
   for ( var t = 0; t < sorted.length; ++t )
      times.push( sorted[t]/kSlow );
   var exact = goal/kSlow, nice = secNiceTime( exact );
   var measured = 0;
   for ( c = 0; c < ch.length; ++c )
      if ( isFinite( ch[c].perSecond ) )
      {
         ch[c].m = nice*ch[c].perSecond;
         ch[c].efficiency = secEfficiency( ch[c].m );
         ++measured;
      }
   return { channels: ch, slow: slow, fast: fast, complete: measured == ch.length,
            times: times, exact: exact, nice: nice };
}

/*
 * The sub-exposure suggestion for one filter.
 *
 * The goal is the middle one of the target multiples (the lower middle for an
 * even number); the lowest and highest give the range worth considering.
 *
 * It is worked out twice. The fields of the result itself use rnE[], the read
 * noise of a typical pixel, which gives the short end. Its "all" member uses
 * rnRmsE[], the read noise over all pixels including the noisy ones, which
 * gives the long end. A dithered stack lands between the two, so when they
 * round to different sub lengths ("range" is true) both are shown.
 */
function secSuggest( filter, names, rates, rnE, rnRmsE, targets, exposures )
{
   var sorted = targets.slice( 0 ).sort( function( a, b ) { return a - b; } );
   var goal = sorted[(sorted.length - 1) >> 1];
   var s = secSuggestFor( names, rates, rnE, sorted, goal );
   if ( s == null )
      return null;
   s.all = secSuggestFor( names, rates, rnRmsE, sorted, goal ) || s;
   s.range = s.all.nice > s.nice;
   s.filter = filter;
   s.targets = sorted;
   s.goal = goal;
   s.exposures = exposures.slice( 0 ).sort( function( a, b ) { return a - b; } );
   return s;
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
 * The calculation runs in two stages, so that the camera has to be measured
 * only once:
 *
 *   secMeasureCamera( p, log )           bias level, read noise, conversion gain
 *   secMeasureLights( camera, p, log )   sky rate of every light frame, suggestion
 *
 * secCompute( p, log ) runs both, or only the second when p.camera holds an
 * earlier camera measurement.
 *
 * p = { biasFrames [] (or bias1, bias2), gainMode ("flats" | "manual"),
 *       flatFrames [] (or flat1, flat2), manualGain,
 *       sensor ("auto" | "mono" | "RGGB" ...),                      camera stage
 *       lights [], bgMode ("tiles" | "frame" | "region"), bgRegion, light stage
 *       targets [], fallbackExposure, siteLat, siteLon,
 *       camera (optional), loader (optional) }
 *
 * bgRegion = { x0, y0, x1, y1, source } is a rectangle in image pixels chosen
 * by the user. With bgMode "region" its median is taken as the sky background
 * of every light frame.
 */

// Sample standard deviation of a list as a percentage of a reference value,
// or NaN for fewer than two values.
function secSpreadPct( values, reference )
{
   var n = values.length;
   if ( n < 2 || !(reference > 0) )
      return NaN;
   var mean = 0, i;
   for ( i = 0; i < n; ++i )
      mean += values[i];
   mean /= n;
   var ss = 0;
   for ( i = 0; i < n; ++i )
      ss += (values[i] - mean)*(values[i] - mean);
   return 100*Math.sqrt( ss/(n - 1) )/reference;
}

/*
 * Stage 1. Returns the camera measurement as plain data (numbers, strings and
 * arrays only), so it can be stored and used again later. ADU figures in it
 * are as stored in the file.
 *
 * The frames are p.biasFrames [] and, with gainMode "flats", p.flatFrames []
 * (or the pairs p.bias1, p.bias2 and p.flat1, p.flat2). Any even number of
 * bias frames is used, two at a time in the order given, and the medians over
 * the pairs are taken. Flat frames are paired in the order given too: two
 * neighbours form a pair when they were taken through the same filter at the
 * same brightness. The gain does not depend on the filter, so flats through
 * any mix of filters can be given and all pairs count towards one figure.
 */
function secMeasureCamera( p, log )
{
   var load = p.loader || secLoadFrame;
   var warnings = [];
   log = log || function() {};
   var biasFiles = p.biasFrames || [p.bias1, p.bias2];
   var flatFiles = (p.gainMode == "flats") ? (p.flatFrames || [p.flat1, p.flat2]) : [];
   if ( biasFiles.length < 2 )
      throw new Error( "At least two bias frames are needed." );

   // ---- 1. Bias pairs: bias level and read noise --------------------------
   var pairs = biasFiles.length >> 1;
   if ( biasFiles.length & 1 )
      warnings.push( "An odd number of bias frames was given. The last one, " +
         secBaseName( biasFiles[biasFiles.length - 1] ) + ", was not used." );
   var w = 0, h = 0, layout = null, nch = 0, shift = 0, step = 1, fullScale = SEC_ADU_MAX;
   var biasRef = null, biasNames = null;
   var levels = [], noises = [], rmsNoises = [], c;
   for ( var pair = 0; pair < pairs; ++pair )
   {
      log( (pairs > 1) ? "Reading bias pair " + (pair + 1) + " of " + pairs + "..." : "Reading bias frames..." );
      var b1 = load( biasFiles[2*pair] ), b2 = load( biasFiles[2*pair + 1] );
      secCheckSize( b1, b2 );
      if ( pair == 0 )
      {
         w = b1.width;
         h = b1.height;
         layout = secLayout( p.sensor, b1 );
         nch = layout.nch;
         for ( c = 0; c < nch; ++c )
         {
            levels.push( [] );
            noises.push( [] );
            rmsNoises.push( [] );
         }

         var biasExp = secNum( secKw( b1, ["EXPTIME", "EXPOSURE"] ) );
         if ( isFinite( biasExp ) && biasExp > 1 )
            warnings.push( "The bias frames have an exposure of " + biasExp + " s. Use the shortest " +
               "exposure your camera allows, otherwise dark current is counted as read noise." );

         // Bit depth. When the camera's values are stored shifted up to the
         // 16 bit range, every frame is first brought back to the camera's own
         // ADU steps. Inside both stages "ADU" means those steps; the results
         // are converted back to ADU as stored in the file.
         shift = secDataShift( b1.data, b2.data );
         step = 1 << shift;
         fullScale = SEC_ADU_MAX >> shift;
         biasRef = { name: b1.name, keywords: b1.keywords, width: w, height: h };
         biasNames = [b1.name, b2.name];
      }
      else
      {
         secCheckSize( biasRef, b1 );
         secCheckKeyword( biasRef, b1, ["GAIN"], "gain", warnings );
         secCheckKeyword( biasRef, b1, ["OFFSET"], "offset", warnings );
      }
      secToCameraSteps( b1, shift, warnings );
      secToCameraSteps( b2, shift, warnings );

      var hb1 = secHistograms( b1.data, w, layout, 0, 0, w, h );
      var hb2 = secHistograms( b2.data, w, layout, 0, 0, w, h );
      var hbd = secDiffHistograms( b1.data, b2.data, w, layout, 0, 0, w, h );
      for ( c = 0; c < nch; ++c )
      {
         var noise = hbd[c].clipped( 5 ).sd/Math.SQRT2;
         if ( !(noise > 0) )
            throw new Error( "The bias frames " + b1.name + " and " + b2.name + " are identical or " +
               "contain no noise. Please select different raw bias frames." );
         levels[c].push( 0.5*(hb1[c].median() + hb2[c].median()) );
         noises[c].push( noise );
         // plain RMS over every pixel, including the noisy outlier pixels
         rmsNoises[c].push( hbd[c].moments( -SEC_ADU_MAX, SEC_ADU_MAX ).sd/Math.SQRT2 );
      }
      b1.data = b2.data = null;
   }

   // the median over the pairs: one odd pair, or a cosmic ray hit in one
   // frame, does not move it
   var biasLevel = [], rnADU = [], rnRmsADU = [], coarse = false, rnSpread = NaN;
   for ( c = 0; c < nch; ++c )
   {
      biasLevel.push( secMedianOf( levels[c] ) );
      rnADU.push( secMedianOf( noises[c] ) );
      rnRmsADU.push( secMedianOf( rmsNoises[c] ) );
      if ( rnADU[c] < 0.5 )
         coarse = true;
      var spread = secSpreadPct( noises[c], rnADU[c] );
      if ( isFinite( spread ) && !(spread <= rnSpread) )
         rnSpread = spread;
   }
   if ( coarse )
      warnings.push( "The read noise is less than half of one ADU step of the camera at this gain " +
         "setting. Noise that small cannot be measured reliably from bias frames, so treat the " +
         "read noise and the calculated times as approximate." );
   if ( rnSpread > 5 )
      warnings.push( "The read noise differs by " + secFmt( rnSpread, 0 ) + "% between the bias " +
         "pairs. Check that all bias frames were taken at the same gain, offset and temperature." );

   // ---- 2. Conversion gain ------------------------------------------------
   var gain = NaN, gainPerChannel = null, gainSource = "", flatNames = null;
   var flatPairs = 0, flatSkipped = [], gainByFilter = null, gainSpread = NaN;
   if ( p.gainMode == "flats" )
   {
      if ( flatFiles.length < 2 )
         throw new Error( "At least two flat frames are needed to measure the conversion gain." );
      // central half of the frame, to stay away from vignetted corners
      var x0 = (w >> 2) & ~1, x1 = w - x0, y0 = (h >> 2) & ~1, y1 = h - y0;
      var single = flatFiles.length == 2; // exactly one pair: use it whatever it looks like, and say so
      var perChannel = [], good = [], usable = [], pairGains = [], filters = {}, filterOrder = [];
      var saturated = {};
      for ( c = 0; c < nch; ++c )
         perChannel.push( [] );

      // reads one flat and takes the statistics that every pairing needs
      var readFlat = function( index )
      {
         var f = load( flatFiles[index] );
         secCheckSize( biasRef, f );
         secCheckKeyword( biasRef, f, ["GAIN"], "gain", warnings );
         secCheckKeyword( biasRef, f, ["OFFSET"], "offset", warnings );
         secToCameraSteps( f, shift, warnings );
         f.hist = secHistograms( f.data, w, layout, x0, y0, x1, y1 );
         f.means = [];
         for ( var k = 0; k < nch; ++k )
            f.means.push( f.hist[k].moments( 0, SEC_ADU_MAX ).mean );
         f.filter = secKw( f, ["FILTER"] ) || "(none)";
         return f;
      };

      var i = 0, f1 = null;
      while ( i + 1 < flatFiles.length )
      {
         log( single ? "Reading flat frames..." :
            "Reading flat frames " + (i + 1) + " and " + (i + 2) + " of " + flatFiles.length + "..." );
         if ( f1 == null )
            f1 = readFlat( i );
         var f2 = readFlat( i + 1 );

         // two neighbours form a pair when the filter and the brightness match
         var matched = f1.filter == f2.filter;
         for ( c = 0; c < nch; ++c )
            if ( Math.abs( f1.means[c] - f2.means[c] ) > 0.02*Math.max( f1.means[c], f2.means[c] ) )
            {
               matched = false;
               if ( single )
                  warnings.push( "Flat frames differ in brightness by more than 2% in channel " +
                     layout.names[c] + ". Use two flats taken back to back with a steady light source." );
            }
         if ( !matched && !single )
         {
            flatSkipped.push( f1.name );
            f1.data = null;
            f1 = f2;
            i += 1;
            continue;
         }

         var hfd = secDiffHistograms( f1.data, f2.data, w, layout, x0, y0, x1, y1 );
         var pairGood = [];
         for ( c = 0; c < nch; ++c )
         {
            var signal = 0.5*(f1.means[c] + f2.means[c]) - biasLevel[c];
            var sd = hfd[c].clipped( 5 ).sd;
            var shotVar = 0.5*sd*sd - rnADU[c]*rnADU[c];
            var g = (signal > 0 && shotVar > 0) ? signal/shotVar : NaN;
            var bright = f1.hist[c].quantile( 0.999 );
            if ( isFinite( g ) && bright < 0.9*fullScale )
            {
               perChannel[c].push( g );
               usable.push( g );
               if ( signal*step >= 1000 )
               {
                  good.push( g );
                  pairGood.push( g );
               }
            }
            else if ( bright >= 0.9*fullScale )
               saturated[layout.names[c]] = true;
         }
         if ( pairGood.length > 0 )
         {
            var pairGain = secMedianOf( pairGood );
            pairGains.push( pairGain );
            if ( filters[f1.filter] === undefined )
            {
               filters[f1.filter] = [];
               filterOrder.push( f1.filter );
            }
            filters[f1.filter].push( pairGain );
         }
         if ( flatNames == null )
            flatNames = [f1.name, f2.name];
         ++flatPairs;
         f1.data = f2.data = null;
         f1 = null;
         i += 2;
      }
      if ( f1 != null )
         flatSkipped.push( f1.name ); // the last frame found no partner

      for ( var name in saturated )
         warnings.push( "Flat channel " + name + " is close to saturation" +
            (single ? " and" : " in some frames. Those") + " was not used for the gain measurement." );
      if ( flatSkipped.length > 0 )
         warnings.push( flatSkipped.length + " flat frame(s) had no neighbour through the same filter at " +
            "the same brightness and were not used, for example " + flatSkipped[0] + "." );

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
            "Check that they are different, unsaturated raw flats taken at the same gain " +
            "and offset as the bias frames, in pairs through the same filter, or enter the gain by hand." );

      gainPerChannel = [];
      for ( c = 0; c < nch; ++c )
         gainPerChannel.push( (perChannel[c].length > 0) ? secMedianOf( perChannel[c] ) : NaN );
      gainSpread = secSpreadPct( pairGains, gain );
      gainByFilter = [];
      var lowest = Infinity, highest = 0;
      for ( var q = 0; q < filterOrder.length; ++q )
      {
         var filterGain = secMedianOf( filters[filterOrder[q]] );
         gainByFilter.push( { filter: filterOrder[q], pairs: filters[filterOrder[q]].length, gain: filterGain/step } );
         lowest = Math.min( lowest, filterGain );
         highest = Math.max( highest, filterGain );
      }
      if ( highest > 1.03*lowest )
         warnings.push( "The gain measured through different filters differs by " +
            secFmt( 100*(highest/lowest - 1), 0 ) + "%. The gain belongs to the camera and should " +
            "not depend on the filter, so the flats through one of them are probably too bright, too " +
            "faint or uneven." );
      gainSource = "measured from flats";
   }
   else
   {
      if ( !(p.manualGain > 0) )
         throw new Error( "Please enter a conversion gain greater than zero (e-/ADU)." );
      gain = p.manualGain*step; // typed per ADU as stored in the file
      gainSource = "entered by hand";
   }

   var rnE = [], rnRmsE = [], extreme = false;
   for ( var c2 = 0; c2 < nch; ++c2 )
   {
      rnE.push( rnADU[c2]*gain );
      rnRmsE.push( rnRmsADU[c2]*gain );
      if ( rnRmsADU[c2] > 2*rnADU[c2] )
         extreme = true;
   }
   if ( extreme )
      warnings.push( "The read noise over all pixels is more than twice that of a typical pixel. " +
         "A few extreme pixels or cosmic ray hits in the bias frames can cause this, and the long " +
         "end of the suggested range is then too long. " + ((pairs > 1) ? "Check the bias frames." :
         "Two fresh bias frames at the shortest exposure usually cure it.") );

   // ADU figures in the result are as stored in the file.
   function scaled( a, factor )
   {
      if ( a == null )
         return null;
      var out = [];
      for ( var i2 = 0; i2 < a.length; ++i2 )
         out.push( a[i2]*factor );
      return out;
   }
   return {
      format: 1, width: w, height: h, layout: layout, biasLevel: scaled( biasLevel, step ),
      rnADU: scaled( rnADU, step ), rnE: rnE, rnRmsADU: scaled( rnRmsADU, step ), rnRmsE: rnRmsE,
      gain: gain/step, gainPerChannel: scaled( gainPerChannel, 1/step ), gainSource: gainSource,
      step: step, bits: 16 - shift, gainCamera: gain,
      gainSetting: secKw( biasRef, ["GAIN"] ), offsetSetting: secKw( biasRef, ["OFFSET"] ),
      temperature: secKw( biasRef, ["SET-TEMP", "CCD-TEMP"] ),
      instrument: secKw( biasRef, ["INSTRUME"] ),
      biasNames: biasNames, flatNames: flatNames, biasPairs: pairs, flatPairs: flatPairs,
      flatSkipped: flatSkipped.length, rnSpreadPct: rnSpread, gainSpreadPct: gainSpread,
      gainByFilter: gainByFilter, warnings: warnings
   };
}

/*
 * Brings a frame to the camera's own ADU steps and warns when it does not
 * hold whole steps, which means it was not made the same way as the bias
 * frames.
 */
function secToCameraSteps( frame, shift, warnings )
{
   var odd = secShiftData( frame.data, shift );
   if ( odd > 0.0001*frame.data.length )
      warnings.push( frame.name + " holds values that are not multiples of " + (1 << shift) +
         ", unlike the bias frames. It seems to come from a different camera mode or capture " +
         "program, and its results are unreliable." );
}

/*
 * Stage 2. Measures the sky background of every light frame with a camera
 * measurement from stage 1 and works out the sub-exposure times.
 */
function secMeasureLights( camera, p, log )
{
   var load = p.loader || secLoadFrame;
   var warnings = [];
   log = log || function() {};

   // The camera measurement holds ADU as stored in the file. Statistics are
   // taken in the camera's own steps, so convert what is needed back.
   var w = camera.width, h = camera.height, layout = camera.layout, nch = layout.nch;
   var step = camera.step, shift = 0;
   while ( (1 << shift) < step )
      ++shift;
   var fullScale = SEC_ADU_MAX >> shift;
   var gain = camera.gainCamera, rnE = camera.rnE, rnRmsE = camera.rnRmsE;
   var biasLevel = [];
   for ( var c = 0; c < nch; ++c )
      biasLevel.push( camera.biasLevel[c]/step );
   var biasRef = { name: camera.biasNames ? camera.biasNames[0] : "the camera measurement",
                   keywords: { GAIN: camera.gainSetting, OFFSET: camera.offsetSetting },
                   width: w, height: h };

   // A background region chosen by the user, if any
   var region = null;
   if ( p.bgMode == "region" )
   {
      var given = p.bgRegion;
      if ( !given )
         throw new Error( "No background region was given." );
      region = { x0: Math.max( 0, Math.round( given.x0 ) ), y0: Math.max( 0, Math.round( given.y0 ) ),
                 x1: Math.min( w, Math.round( given.x1 ) ), y1: Math.min( h, Math.round( given.y1 ) ),
                 source: given.source || "" };
      var rw = region.x1 - region.x0, rh = region.y1 - region.y0;
      if ( !(rw >= 8) || !(rh >= 8) )
         throw new Error( "The background region lies outside the frame or is smaller than " +
            "8 x 8 pixels. The frames are " + w + " x " + h + " pixels." );
      if ( rw*rh < 2500*(layout.cfa ? 4 : 1) )
         warnings.push( "The background region is small (" + rw + " x " + rh + " pixels), which " +
            "makes the background less certain. A region of at least 100 x 100 pixels is better." );
   }

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
      secToCameraSteps( L, shift, warnings );

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
      // Background, and the scatter that the noise check compares with the
      // prediction: of the user's region when there is one, else of the frame.
      var bg, scatter = mad;
      if ( region != null )
      {
         var hr = secHistograms( L.data, w, layout, region.x0, region.y0, region.x1, region.y1 );
         bg = [];
         scatter = [];
         for ( var c6 = 0; c6 < nch; ++c6 )
         {
            bg.push( hr[c6].median() );
            scatter.push( hr[c6].mad() );
         }
      }
      else
         bg = (p.bgMode == "tiles") ? secTileBackground( L.data, w, h, layout, med, 0.20 ) : med;

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
            name: layout.names[c4], bgADU: bg[c4]*step, skyADU: skyADU*step, skyE: skyE, rate: rate,
            m: mNow, efficiency: valid ? secEfficiency( mNow ) : NaN, times: times,
            noiseRatio: 1.4826*scatter[c4]*gain/predicted,
            clippedPct: 100*(hl[c4].n - hl[c4].cdf( 0.98*fullScale ))/Math.max( 1, hl[c4].n )
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
   var summary = [], suggestions = [];
   for ( var o = 0; o < order.length; ++o )
   {
      var G = groups[order[o]], groupRates = [], exposures = [];
      for ( var q0 = 0; q0 < G.length; ++q0 )
         if ( exposures.indexOf( G[q0].exposure ) < 0 )
            exposures.push( G[q0].exposure );
      for ( var c5 = 0; c5 < nch; ++c5 )
      {
         var rates = [];
         for ( var q = 0; q < G.length; ++q )
            if ( isFinite( G[q].channels[c5].rate ) )
               rates.push( G[q].channels[c5].rate );
         var r = secMedianOf( rates );
         groupRates.push( r );
         var tt = [];
         for ( var t2 = 0; t2 < targets.length; ++t2 )
            tt.push( (r > 0) ? targets[t2]*rnE[c5]*rnE[c5]/r : NaN );
         summary.push( { filter: order[o], channel: layout.names[c5], frames: rates.length,
                         rate: r, times: tt } );
      }
      // ---- 5. One suggested sub-exposure per filter --------------------------
      var suggestion = secSuggest( order[o], layout.names, groupRates, rnE, rnRmsE, targets, exposures );
      if ( suggestion != null )
      {
         suggestion.frames = G.length;
         suggestions.push( suggestion );
      }
   }

   return { targets: targets, frames: frames, summary: summary, suggestions: suggestions,
            background: { mode: p.bgMode, region: region }, warnings: warnings };
}

/*
 * Both stages. With p.camera set, the camera is not measured again.
 */
function secCompute( p, log )
{
   var camera = p.camera || secMeasureCamera( p, log );
   var r = secMeasureLights( camera, p, log );
   r.camera = camera;
   r.warnings = (camera.warnings || []).concat( r.warnings );
   return r;
}

// How the sky background of the light frames was found, in words.
function secBackgroundText( background )
{
   if ( background.mode == "region" && background.region )
   {
      var g = background.region;
      return "your region" + (g.source != "" ? " " + g.source : "") + ", x " + g.x0 + " to " + g.x1 +
         ", y " + g.y0 + " to " + g.y1 + " (" + (g.x1 - g.x0) + " x " + (g.y1 - g.y0) + " pixels)";
   }
   return (background.mode == "tiles") ? "darkest tiles" : "whole frame median";
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
   if ( cam.biasNames )
   {
      var from = (cam.biasPairs > 1) ? 2*cam.biasPairs + " bias frames" : cam.biasNames.join( " and " );
      if ( cam.flatPairs > 1 )
         from += " and " + 2*cam.flatPairs + " flat frames";
      lines.push( (r.cameraName ? "Camera \"" + r.cameraName + "\", measured" : "Camera measured") +
         (cam.measuredAt ? " " + cam.measuredAt : "") + " from " + from );
   }
   lines.push( "Sensor: " + (cam.layout.cfa ? "colour, Bayer pattern " + cam.layout.pattern : "mono") +
      ", " + cam.width + " x " + cam.height +
      (cam.gainSetting != "" ? ", gain " + cam.gainSetting : "") +
      (cam.offsetSetting != "" ? ", offset " + cam.offsetSetting : "") +
      (cam.step > 1 ? ", " + cam.bits + " bit data stored in steps of " + cam.step + " ADU" : "") );
   lines.push( "Bias level: " + list( cam.biasLevel, 1, "ADU" ) );
   lines.push( "Read noise (typical pixel, used for the table): " + list( cam.rnE, 2, "e-" ) +
      "   (" + list( cam.rnADU, 2, "ADU" ) + ")" );
   lines.push( "Read noise (RMS of all pixels, including noisy outliers): " + list( cam.rnRmsE, 2, "e-" ) );
   lines.push( "Conversion gain: " + secFmt( cam.gain, 4 ) + " e-/ADU" +
      (cam.step > 1 ? " as stored in the file = " + secFmt( cam.gainCamera, 3 ) + " e- per " +
         cam.bits + " bit ADU of the camera" : "") + ", " + cam.gainSource +
      (cam.gainPerChannel ? "   (per channel: " + list( cam.gainPerChannel, 4, "" ) + ")" : "") );
   // with several pairs: how well they agree with each other
   var scatter = [];
   if ( secIsNumber( cam.rnSpreadPct ) )
      scatter.push( "read noise " + secFmt( cam.rnSpreadPct, 1 ) + "% over " + cam.biasPairs + " bias pairs" );
   if ( secIsNumber( cam.gainSpreadPct ) )
      scatter.push( "gain " + secFmt( cam.gainSpreadPct, 1 ) + "% over " + cam.flatPairs + " flat pairs" );
   var perFilter = [];
   if ( cam.gainByFilter && cam.gainByFilter.length > 1 )
      for ( var q = 0; q < cam.gainByFilter.length; ++q )
         perFilter.push( cam.gainByFilter[q].filter + " " + secFmt( cam.gainByFilter[q].gain, 4 ) );
   if ( scatter.length > 0 || perFilter.length > 0 )
      lines.push( (scatter.length > 0 ? "Scatter between pairs: " + scatter.join( ", " ) + ". " : "") +
         (perFilter.length > 0 ? "Gain per filter: " + perFilter.join( ", " ) + "." : "") );
   return lines;
}

// " for filter Ha", or nothing when the frames name no filter.
function secFilterSuffix( filter )
{
   return (filter == "(none)") ? "" : " for filter " + filter;
}

// The suggestion as it is quoted: "6 min", or "6 to 9 min" when the two read
// noise figures round to different sub lengths.
function secSuggestionSpan( s )
{
   var a = secFmtNice( s.nice );
   if ( !s.range )
      return a;
   var b = secFmtNice( s.all.nice );
   var unitA = a.replace( /^[0-9.]+/, "" ), unitB = b.replace( /^[0-9.]+/, "" );
   return ((unitA == unitB) ? a.substring( 0, a.length - unitA.length ) : a) + " to " + b;
}

/*
 * The suggested sub-exposure for one filter as plain text lines. The first
 * line is the headline; the others explain where it comes from.
 */
function secSuggestionLines( s )
{
   var colour = s.channels.length > 1;
   var all = s.all;
   var slow = s.channels[s.slow].name, slowAll = all.channels[all.slow].name;
   var n = s.targets.length;
   var lines = [];

   // where every channel lands at one end of the suggestion
   function landing( side )
   {
      var at = [];
      for ( var c = 0; c < side.channels.length; ++c )
         if ( isFinite( side.channels[c].m ) )
            at.push( (colour ? side.channels[c].name + " " : "") + "m = " + secFmt( side.channels[c].m, 1 ) +
               " (" + secFmt( 100*side.channels[c].efficiency, 1 ) + "%)" );
      return at.join( ", " ) + ".";
   }
   // "(m = 3 in B, typical pixel)"
   function basis( m, channel, kind )
   {
      var parts = [];
      if ( colour )
         parts.push( "in " + channel );
      if ( s.range )
         parts.push( kind );
      return " (m = " + m + (parts.length > 0 ? " " + parts.join( ", " ) : "") + ")";
   }

   lines.push( "Suggested sub-exposure" + secFilterSuffix( s.filter ) + ": about " + secSuggestionSpan( s ) );
   if ( s.range )
   {
      lines.push( secFmtNice( s.nice ) + " is the time " + (colour ? slow + " needs" : "needed") +
         " to reach m = " + s.goal + " with the read noise of a typical pixel (calculated " +
         secFmtTime( s.exact ) + "). " + secFmtNice( all.nice ) + " is the time " +
         (colour ? slowAll + " needs" : "needed") + " with the read noise over all pixels, noisy " +
         "ones included (calculated " + secFmtTime( all.exact ) + "). A stack lands between the " +
         "two, nearer the long end if you dither." );
      if ( colour )
         lines.push( slow + " has the weakest sky for its read noise, and one exposure has to " +
            "serve all channels, so it sets the time." );
      lines.push( "At " + secFmtNice( s.nice ) + ", typical pixel: " + landing( s ) );
      lines.push( "At " + secFmtNice( all.nice ) + ", all pixels: " + landing( all ) );
   }
   else
   {
      // both read noise figures round to the same sub length
      var same = (all.exact > 1.02*s.exact) ? " With the read noise over all pixels it is " +
         secFmtTime( all.exact ) + ", which rounds to the same sub length." : "";
      if ( colour )
         lines.push( "Calculated " + secFmtTime( s.exact ) + ", the time " + slow + " needs to reach m = " +
            s.goal + ". " + slow + " has the weakest sky for its read noise, and one exposure has to " +
            "serve all channels, so it sets the time." + same );
      else
         lines.push( "Calculated " + secFmtTime( s.exact ) + " for m = " + s.goal + "." + same );
      lines.push( "At " + secFmtNice( s.nice ) + ": " + landing( s ) );
   }

   // the short limit from the typical pixel, the long limit from all pixels
   var range = "";
   if ( s.goal > s.targets[0] )
      range += "Shorter subs stay worthwhile down to " + secFmtTime( s.times[0] ) +
         basis( s.targets[0], slow, "typical pixel" ) + ". ";
   if ( s.goal < s.targets[n - 1] )
      range += "Beyond " + secFmtTime( all.times[n - 1] ) + basis( s.targets[n - 1], slowAll, "all pixels" ) +
         " there is almost nothing left to gain.";
   if ( range != "" )
      lines.push( secTrim( range ) );
   if ( !s.complete )
      lines.push( "Not every channel could be measured, so this covers the measured ones only." );
   return lines;
}

function secConsoleReport( r )
{
   var i, j, k;
   console.writeln( "<end><cbr><br><b>" + SEC_TITLE + " " + SEC_VERSION + "</b>" );
   var cam = secCameraText( r );
   for ( i = 0; i < cam.length; ++i )
      console.writeln( cam[i].replace( /</g, "" ) );
   console.writeln( "Sky background from: " + secBackgroundText( r.background ).replace( /</g, "" ) );
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
   for ( i = 0; i < r.suggestions.length; ++i )
   {
      // an opening angle bracket would be read as a console tag
      var lines = secSuggestionLines( r.suggestions[i] );
      console.writeln( "" );
      for ( j = 0; j < lines.length; ++j )
      {
         var text = lines[j].replace( /</g, "" );
         console.writeln( (j == 0) ? "<b>" + text + "</b>" : "   " + text );
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
      "moon_phase", "moon_alt_deg", "moon_sep_deg", "sun_alt_deg", "target_alt_deg",
      "background_from"] );
   var from = secBackgroundText( r.background );
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
         row.push( from );
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
      "<p><b>Bias frames, two or more.</b> Shortest possible exposure, sensor covered. <i>Single</i> " +
      "frames, not a master: stacking averages the noise away, which is exactly what we want to " +
      "measure.</p>" +
      "<p><b>Flat frames, two or more (optional).</b> Taken back to back with a steady light " +
      "source, somewhere between a third and a half of full scale. They are used to measure the " +
      "conversion gain. Any filters will do, since the gain belongs to the camera. If you have no " +
      "flats, type the e-/ADU value from the manufacturer's chart instead.</p>" +
      "<p><b>One or more light frames.</b> Ordinary subs of any target, one or several per filter. " +
      "The exposure time and filter name are read from the FITS header.</p>" +
      "<p><b>12 and 14 bit cameras</b> need nothing special. Most capture programs store their " +
      "values scaled up to 16 bit, so a 12 bit camera only produces multiples of 16. The script " +
      "detects this from the bias frames and measures in the camera's own steps. ADU values are " +
      "still shown as stored in the file, and the results name the bit depth and give the gain " +
      "both ways.</p>" },
   { title: "3. Step by step", html:
      "<p><b>Step by step</b></p>" +
      "<ol><li>The first time, press <b>New</b> in step 1. Add your bias frames, then your flat " +
      "frames or a typed gain, and press <i>Measure and save</i>. The camera now appears in the " +
      "list.</li>" +
      "<li>From then on, just choose the camera in step 1.</li>" +
      "<li>Add your light frames. Mix filters freely; results are grouped by filter.</li>" +
      "<li>Choose the multiples of read noise squared you want times for (3, 5 and 10 by default).</li>" +
      "<li>Press <b>Calculate</b>. A suggested sub-exposure appears above the table, with the " +
      "measurements below it and more detail in the Process Console.</li>" +
      "<li>Press <b>Graph</b> to see how efficiency grows with sub length for each channel, and " +
      "where the suggestion sits on that curve.</li>" +
      "<li>Press <b>Save CSV</b> to keep the results, for example to build a table of sky " +
      "brightness against Moon phase over several nights.</li></ol>" +
      "<p>For a colour camera no debayering is done. The red, green and blue pixels are simply " +
      "measured separately, so no interpolation touches the numbers. The two green positions are " +
      "pooled.</p>" },
   { title: "4. The camera list", html:
      "<p><b>The camera list</b></p>" +
      "<p>Bias level, read noise and gain belong to a camera at <b>one gain, offset and " +
      "binning</b>, not to a night. Each entry in the list is one such measurement. It is saved, " +
      "so Calculate only has to read your light frames. Measure a new entry when you change gain, " +
      "offset or binning; the script warns when a light frame carries a different GAIN or OFFSET " +
      "keyword.</p>" +
      "<p><b>More frames, firmer numbers.</b> Bias frames are used two at a time and the median " +
      "over the pairs is taken, so one odd frame or a cosmic ray hit cannot move the result. Flat " +
      "frames are paired with a neighbour through the same filter at the same brightness; frames " +
      "without such a partner are left out. All pairs count towards one gain. The results show " +
      "how well the pairs agree, and the gain per filter, which should be the same.</p>" +
      "<p><b>Export</b> saves the selected camera as a file, to keep or to use on another " +
      "computer. <b>Import</b> adds one from such a file. <b>Delete</b> removes it from the list; " +
      "your frames are never touched.</p>" +
      "<p>In the <i>New</i> window, leave <i>Sensor</i> on Auto unless the bias frames lack a " +
      "BAYERPAT keyword. A colour sensor is recognised by it; anything else is treated as mono.</p>" },
   { title: "5. Your own background", html:
      "<p><b>Your own background</b></p>" +
      "<p><i>Darkest tiles</i> finds the sky background by itself and copes with a nebula that " +
      "fills much of the frame. <i>Whole frame median</i> is the simple choice for sparse fields.</p>" +
      "<p>To choose the background yourself, open a raw light frame and draw a preview on empty " +
      "sky, 100 x 100 pixels or more and away from the corners, where a raw frame is darker from " +
      "vignetting. Do this before starting the script, because its window blocks the rest of " +
      "PixInsight while it is open. Then set <i>Sky background</i> to <i>Preview</i> and pick it " +
      "from the list beside it. The image it belongs to is added to the light frames.</p>" +
      "<p>The median of that rectangle is used in every light frame in the list, so they should " +
      "share the same framing. The noise check then looks at that rectangle only: a value near " +
      "1.0 means the patch you chose behaves like plain sky.</p>" },
   { title: "6. The theory", html:
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
   { title: "7. How the measurements are made", html:
      "<p><b>How the measurements are made</b></p>" +
      "<p><b>Bias level.</b> The median of the bias frames, per channel. It is the pedestal that " +
      "must be removed before ADU can be turned into electrons.</p>" +
      "<p><b>Read noise.</b> One bias frame is subtracted from the other. Fixed pattern cancels and " +
      "only random noise remains, from two frames. Its standard deviation divided by &radic;2 is " +
      "the read noise of one frame in ADU. Two figures are shown. The <i>typical pixel</i> value " +
      "ignores outliers beyond 5 sigma and is used for the table. The <i>RMS of all pixels</i> " +
      "includes the small share of noisy pixels every CMOS sensor has, and is closer to what " +
      "manufacturers publish. A stack lands between them, so the suggestion shows the time " +
      "for both.</p>" +
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
   { title: "8. The suggested sub-exposure", html:
      "<p><b>The suggested sub-exposure</b></p>" +
      "<p>Above the table the script suggests a sub length per filter, rounded to common " +
      "values. It is the time needed to reach the middle one of your target multiples (5 by " +
      "default). The lowest and highest multiples mark where shorter subs start to lose " +
      "noticeably and where longer ones gain almost nothing.</p>" +
      "<p><b>Why a range.</b> The time depends on the read noise squared, and the script measures " +
      "two read noise figures. The short end uses the typical pixel, the long end the RMS of all " +
      "pixels, noisy ones included. A stack lands between the two, nearer the long end if you " +
      "dither, since each point of sky then falls on many pixels. When both round to the same " +
      "sub length, a single time is shown.</p>" +
      "<p><b>Colour cameras.</b> One exposure has to serve red, green and blue together. The " +
      "channel whose sky builds up most slowly against its read noise therefore sets the time, " +
      "and the other two end up above the target.</p>" +
      "<p><b>Graph.</b> Efficiency against sub length. Solid curves use the typical pixel; the " +
      "dashed curve is the slowest channel with the read noise of all pixels. The gold band is " +
      "the suggestion, the dotted line the exposure of your frames, and the horizontal dashed " +
      "lines your target multiples.</p>" +
      "<p>The suggestion is a calculation from your frames and your chosen multiple, not an " +
      "optimum. It holds for the sky as it was when the frames were taken.</p>" },
   { title: "9. Reading the table", html:
      "<p><b>Reading the table</b></p>" +
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
      "H-beta land in G and B. The channels then ask for very different times, and the suggestion " +
      "follows the slowest one, which can be long. If that is more than your mount or sky allows, " +
      "read the per-channel times in the table and choose the channel you care about most, or a " +
      "compromise.</p>" },
   { title: "10. Practical advice and limits", html:
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
      "pattern by hand.</li>" +
      "<li>Saturation is judged against the 16 bit full scale. Files that hold 12 or 14 bit " +
      "values unscaled, as some DSLR conversions do, are measured correctly, but saturated flats " +
      "and clipped stars are not flagged for them.</li></ul>" +
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
// Graph: stack efficiency against sub-exposure time
// ============================================================================

var SEC_PLOT_COLORS = { R: 0xffff6b6b, G: 0xff5fd97a, B: 0xff6ba8ff, L: 0xffe8e8e8 };
var SEC_PLOT_TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600,
                      7200, 14400, 28800, 86400];

function secTickLabel( seconds )
{
   if ( seconds < 60 )
      return seconds + " s";
   if ( seconds < 3600 )
      return (seconds/60) + " min";
   return (seconds/3600) + " h";
}

/*
 * Everything the graph shows for one suggestion, in data units: the time
 * range, the tick positions and one efficiency curve per measured channel,
 * worked out with the read noise of a typical pixel. When the suggestion is a
 * range, "dashed" is one more curve: the channel that sets the long end, with
 * the read noise over all pixels. No PixInsight calls, so it can be tested
 * outside PixInsight.
 */
function secPlotModel( s )
{
   var n = s.targets.length, all = s.all;
   var kSlow = s.channels[s.slow].perSecond;
   var kSlowAll = all.channels[all.slow].perSecond;
   // the slowest channel runs from 50% efficiency (typical pixel) to 98%
   // (all pixels) across the graph
   var t0 = Math.min( 0.33, 0.6*s.targets[0] )/kSlow;
   var t1 = Math.max( 25, 1.5*s.targets[n - 1] )/Math.min( kSlow, kSlowAll );
   for ( var i = 0; i < s.exposures.length; ++i )
   {
      t0 = Math.min( t0, 0.7*s.exposures[i] );
      t1 = Math.max( t1, 1.4*s.exposures[i] );
   }
   var l0 = Math.log( t0 ), l1 = Math.log( t1 );

   function curvePoints( perSecond )
   {
      var points = [];
      for ( var j = 0; j <= 96; ++j )
      {
         var t = Math.exp( l0 + (l1 - l0)*j/96 );
         points.push( { t: t, e: secEfficiency( t*perSecond ) } );
      }
      return points;
   }
   function colorOf( name )
   {
      return SEC_PLOT_COLORS[name] || SEC_PLOT_COLORS.L;
   }

   var curves = [];
   for ( var c = 0; c < s.channels.length; ++c )
   {
      var ch = s.channels[c];
      if ( !isFinite( ch.perSecond ) )
         continue;
      curves.push( { name: ch.name, color: colorOf( ch.name ), points: curvePoints( ch.perSecond ),
                     m: ch.m, efficiency: ch.efficiency, efficiencyAll: all.channels[c].efficiency } );
   }

   var dashed = null;
   if ( s.range )
   {
      var d = all.channels[all.slow];
      dashed = { name: d.name, color: colorOf( d.name ), points: curvePoints( d.perSecond ),
                 efficiency: d.efficiency };
   }

   var ticks = [];
   for ( var k = 0; k < SEC_PLOT_TICKS.length; ++k )
      if ( SEC_PLOT_TICKS[k] >= t0 && SEC_PLOT_TICKS[k] <= t1 )
         ticks.push( SEC_PLOT_TICKS[k] );

   var levels = [];
   for ( var q = 0; q < n; ++q )
      levels.push( { m: s.targets[q], e: secEfficiency( s.targets[q] ) } );

   return { suggestion: s, t0: t0, t1: t1, e0: 0.5, e1: 1, curves: curves, dashed: dashed,
            ticks: ticks, levels: levels };
}

/*
 * Draws the graph. g is a Graphics object for an area of width x height
 * pixels, font is used to measure text, scale is the display pixel ratio.
 * Outlines are drawn as lines and fills with an explicit brush, so nothing
 * depends on the brush left behind by an earlier call.
 *
 * The graph sits on the left. A panel on the right lists the efficiency of
 * each channel at the suggested time or times and explains the line styles;
 * it is left out when the control is too narrow.
 */
function secPaintPlot( g, width, height, font, scale, model )
{
   var s = model.suggestion, all = s.all, n = s.times.length;
   var BG = 0xff1b1e24, AREA = 0xff242830, BAND = 0xff2f3541, GOLD = 0xff4a3c20, GRID = 0xff3a404b,
       AXIS = 0xff8d96a5, TEXT = 0xffd5d9e0, DIM = 0xffa3abb8, ACCENT = 0xffffb347;
   var pad = Math.round( 8*scale );
   var textH = font.ascent + font.descent;
   var rowH = textH + Math.round( 4*scale );
   var named = model.curves.length > 1;
   var i, x, y;

   // ---- what goes in the side panel, and how wide that makes it ------------
   var heads = [secFmtNice( s.nice )], kinds = null;
   if ( s.range )
   {
      heads.push( secFmtNice( all.nice ) );
      kinds = ["typical", "all"];
   }
   var sample = 3*pad; // width of a line or colour sample
   var nameW = sample + pad + (named ? font.width( "G" ) + pad : 0);
   var colW = [], tableW = nameW;
   for ( i = 0; i < heads.length; ++i )
   {
      colW.push( Math.max( font.width( heads[i] ), font.width( "100.0%" ),
                           kinds ? font.width( kinds[i] ) : 0 ) + 2*pad );
      tableW += colW[i];
   }
   var key = [];
   if ( s.range )
   {
      key.push( { kind: "solid", text: "typical pixel" } );
      key.push( { kind: "dashed", text: "all pixels" + (named ? " (" + model.dashed.name + ")" : "") } );
      key.push( { kind: "gold", text: "suggested" } );
   }
   if ( n > 1 )
      key.push( { kind: "band", text: "m = " + s.targets[0] + " to " + s.targets[n - 1] } );
   var panelW = Math.max( font.width( "Efficiency at" ), tableW );
   for ( i = 0; i < key.length; ++i )
      panelW = Math.max( panelW, sample + pad + font.width( key[i].text ) );

   // ---- geometry -----------------------------------------------------------
   var left = 2*pad + font.width( "100%" );
   var panel = width - left - panelW - 4*pad >= 30*pad;
   var right = panel ? width - panelW - 4*pad : width - 2*pad - Math.round( 0.5*font.width( "30 min" ) );
   var top = 2*pad + textH;
   var bottom = height - 3*pad - 2*textH;
   var l0 = Math.log( model.t0 ), l1 = Math.log( model.t1 );

   function X( t )
   {
      var v = left + (Math.log( t ) - l0)/(l1 - l0)*(right - left);
      return Math.round( Math.max( left, Math.min( right, v ) ) );
   }
   function Y( e )
   {
      return Math.round( bottom - (e - model.e0)/(model.e1 - model.e0)*(bottom - top) );
   }
   function inTime( t ) { return t >= model.t0 && t <= model.t1; }
   function percent( e ) { return secFmt( 100*e, 1 ) + "%"; }
   // Text anchored at (x, y): "l", "c" or "r" horizontally, centred vertically.
   // The rectangle is wider than the text so a small error in the measured
   // width cannot clip it. With backed set, the text gets a dark backing so a
   // curve passing behind it does not make it hard to read.
   function text( tx, ty, str, align, color, backed )
   {
      tx = Math.round( tx );
      var tw = font.width( str ), slack = 2*pad;
      var y0 = Math.round( ty - 0.5*textH ) - 1, y1 = y0 + textH + 2;
      if ( backed )
      {
         var bx = (align == "r") ? tx - tw : ((align == "c") ? Math.round( tx - 0.5*tw ) : tx);
         g.fillRect( bx - 3, y0, bx + tw + 3, y1, new Brush( BG ) );
      }
      g.pen = new Pen( color );
      if ( align == "r" )
         g.drawTextRect( new Rect( tx - tw - slack, y0, tx, y1 ), str, TextAlign_Right | TextAlign_VertCenter );
      else if ( align == "c" )
         g.drawTextRect( new Rect( Math.round( tx - 0.5*tw ) - slack, y0, Math.round( tx + 0.5*tw ) + slack, y1 ),
            str, TextAlign_HorzCenter | TextAlign_VertCenter );
      else
         g.drawTextRect( new Rect( tx, y0, tx + tw + slack, y1 ), str, TextAlign_Left | TextAlign_VertCenter );
   }
   // A curve as unrounded points, so it is not stepped.
   function polyline( points )
   {
      var line = [];
      for ( var j = 0; j < points.length; ++j )
         if ( points[j].e >= model.e0 )
            line.push( new Point(
               left + (Math.log( points[j].t ) - l0)/(l1 - l0)*(right - left),
               bottom - (points[j].e - model.e0)/(model.e1 - model.e0)*(bottom - top) ) );
      if ( line.length > 1 )
         g.drawPolyline( line );
   }

   g.font = font;
   g.antialiasing = true;
   g.fillRect( 0, 0, width, height, new Brush( BG ) );
   if ( right - left < 20*pad || bottom - top < 12*pad )
      return; // too small to draw anything useful
   g.fillRect( left, top, right, bottom, new Brush( AREA ) );

   // from the lowest target multiple (typical pixel) to the highest (all pixels)
   if ( n > 1 )
      g.fillRect( X( s.times[0] ), top, X( all.times[n - 1] ), bottom, new Brush( BAND ) );
   // the suggested range
   var xs = X( s.nice ), xs2 = X( all.nice );
   var showFirst = inTime( s.nice ), showSecond = s.range && inTime( all.nice );
   if ( showFirst && showSecond )
      g.fillRect( xs, top, xs2, bottom, new Brush( GOLD ) );

   // grid
   g.pen = new Pen( GRID, 1 );
   for ( i = 50; i <= 100; i += 10 )
      g.drawLine( left, Y( i/100 ), right, Y( i/100 ) );
   for ( i = 0; i < model.ticks.length; ++i )
      g.drawLine( X( model.ticks[i] ), top, X( model.ticks[i] ), bottom );

   // the efficiency that belongs to each target multiple
   g.pen = new Pen( AXIS, 1, PenStyle_Dash );
   for ( i = 0; i < model.levels.length; ++i )
      if ( model.levels[i].e > model.e0 )
         g.drawLine( left, Y( model.levels[i].e ), right, Y( model.levels[i].e ) );

   // frame
   g.pen = new Pen( AXIS, 1 );
   g.drawLine( left, top, right, top );
   g.drawLine( left, bottom, right, bottom );
   g.drawLine( left, top, left, bottom );
   g.drawLine( right, top, right, bottom );

   // exposure of the frames that were measured
   g.pen = new Pen( DIM, 1, PenStyle_Dot );
   for ( i = 0; i < s.exposures.length; ++i )
      if ( inTime( s.exposures[i] ) )
         g.drawLine( X( s.exposures[i] ), top, X( s.exposures[i] ), bottom );

   // one efficiency curve per channel, and the dashed one for all pixels
   for ( i = 0; i < model.curves.length; ++i )
   {
      g.pen = new Pen( model.curves[i].color, 2*scale );
      polyline( model.curves[i].points );
   }
   if ( model.dashed != null )
   {
      g.pen = new Pen( model.dashed.color, 1.5*scale, PenStyle_Dash );
      polyline( model.dashed.points );
   }

   // the suggestion: a line at each end, with a dot where it meets a curve
   if ( showFirst )
   {
      g.pen = new Pen( ACCENT, 2*scale );
      g.drawLine( xs, top, xs, bottom );
   }
   if ( showSecond )
   {
      g.pen = new Pen( ACCENT, 2*scale, PenStyle_Dash );
      g.drawLine( xs2, top, xs2, bottom );
   }
   if ( showFirst )
      for ( i = 0; i < model.curves.length; ++i )
         if ( model.curves[i].efficiency >= model.e0 )
         {
            g.pen = new Pen( BG, 1 );
            g.brush = new Brush( model.curves[i].color );
            g.drawCircle( xs, Y( model.curves[i].efficiency ), Math.round( 4*scale ) );
         }
   if ( showSecond && model.dashed.efficiency >= model.e0 )
   {
      g.pen = new Pen( BG, 1 );
      g.brush = new Brush( model.dashed.color );
      g.drawCircle( xs2, Y( model.dashed.efficiency ), Math.round( 4*scale ) );
   }

   // axis labels
   for ( i = 50; i <= 100; i += 10 )
      text( left - pad, Y( i/100 ), i + "%", "r", DIM );
   var lastRight = -1e9;
   for ( i = 0; i < model.ticks.length; ++i )
   {
      var label = secTickLabel( model.ticks[i] ), half = 0.5*font.width( label );
      x = X( model.ticks[i] );
      if ( x - half < lastRight + pad )
         continue;
      text( x, bottom + pad + 0.5*textH, label, "c", DIM );
      lastRight = x + half;
   }
   text( pad, pad + 0.5*textH, "Stack efficiency", "l", TEXT );
   text( 0.5*(left + right), height - pad - 0.5*textH, "Sub-exposure time (logarithmic scale)", "c", TEXT );

   // target multiples, written under their dashed line at the right, where
   // every curve has already risen above it
   var lastY = 1e9;
   for ( i = 0; i < model.levels.length; ++i )
   {
      var level = model.levels[i];
      y = Y( level.e ) + 0.5*textH + 2;
      if ( level.e <= model.e0 || lastY - y < textH )
         continue;
      text( right - pad, y, "m = " + level.m + "  (" + secFmt( 100*level.e, 0 ) + "%)", "r", DIM, true );
      lastY = y;
   }

   // measured exposures, labelled on the side where the label neither leaves
   // the graph nor runs through a suggestion line
   function crossed( from, to )
   {
      return (showFirst && xs > from && xs < to) || (showSecond && xs2 > from && xs2 < to);
   }
   for ( i = 0; i < s.exposures.length; ++i )
      if ( inTime( s.exposures[i] ) )
      {
         x = X( s.exposures[i] );
         var mine = "your frames: " + secFmtNice( s.exposures[i] ), mineW = font.width( mine );
         var fitsRight = x + pad + mineW < right && !crossed( x, x + 2*pad + mineW );
         var fitsLeft = x - pad - mineW > left && !crossed( x - 2*pad - mineW, x );
         if ( fitsRight || !fitsLeft )
            text( x + pad, bottom - pad - 0.5*textH, mine, "l", DIM, true );
         else
            text( x - pad, bottom - pad - 0.5*textH, mine, "r", DIM, true );
      }

   // the suggestion, named above the graph
   if ( showFirst )
   {
      var tag = "suggested: " + secSuggestionSpan( s ), tagHalf = 0.5*font.width( tag );
      var minX = 2*pad + font.width( "Stack efficiency" ) + pad + tagHalf;
      var maxX = (panel ? right : width - pad) - tagHalf;
      text( Math.max( minX, Math.min( maxX, showSecond ? 0.5*(xs + xs2) : xs ) ), pad + 0.5*textH, tag, "c", ACCENT );
   }

   // ---- side panel ---------------------------------------------------------
   if ( !panel )
      return;
   var px = right + 2*pad, py = top, cx;
   text( px, py + 0.5*rowH, "Efficiency at", "l", TEXT );
   py += rowH;
   for ( i = 0, cx = px + nameW; i < heads.length; ++i )
   {
      cx += colW[i];
      text( cx, py + 0.5*rowH, heads[i], "r", ACCENT );
   }
   py += rowH;
   if ( kinds != null )
   {
      for ( i = 0, cx = px + nameW; i < kinds.length; ++i )
      {
         cx += colW[i];
         text( cx, py + 0.5*rowH, kinds[i], "r", DIM );
      }
      py += rowH;
   }
   for ( i = 0; i < model.curves.length && py + rowH <= bottom; ++i )
   {
      y = Math.round( py + 0.5*rowH );
      g.pen = new Pen( model.curves[i].color, 2*scale );
      g.drawLine( px, y, px + sample, y );
      if ( named )
         text( px + sample + pad, y, model.curves[i].name, "l", TEXT );
      text( px + nameW + colW[0], y, percent( model.curves[i].efficiency ), "r", TEXT );
      if ( s.range )
         text( px + nameW + colW[0] + colW[1], y, percent( model.curves[i].efficiencyAll ), "r", TEXT );
      py += rowH;
   }
   py += Math.round( 0.75*rowH );
   for ( i = 0; i < key.length && py + rowH <= bottom; ++i )
   {
      y = Math.round( py + 0.5*rowH );
      var boxTop = y - Math.round( 0.4*textH ), boxBottom = y + Math.round( 0.4*textH );
      if ( key[i].kind == "solid" )
      {
         g.pen = new Pen( DIM, 2*scale );
         g.drawLine( px, y, px + sample, y );
      }
      else if ( key[i].kind == "dashed" )
      {
         g.pen = new Pen( DIM, 1.5*scale, PenStyle_Dash );
         g.drawLine( px, y, px + sample, y );
      }
      else
      {
         g.fillRect( px, boxTop, px + sample, boxBottom, new Brush( (key[i].kind == "gold") ? GOLD : BAND ) );
         g.pen = new Pen( (key[i].kind == "gold") ? ACCENT : AXIS, 1 );
         g.drawLine( px, boxTop, px, boxBottom );
         g.drawLine( px + sample, boxTop, px + sample, boxBottom );
      }
      text( px + sample + pad, y, key[i].text, "l", DIM );
      py += rowH;
   }
}

function SecGraphDialog( results )
{
   this.__base__ = Dialog;
   this.__base__();
   var self = this;
   this.windowTitle = SEC_TITLE + ": suggested sub-exposure";
   this.userResizable = true;
   this.suggestions = results.suggestions;
   this.model = secPlotModel( this.suggestions[0] );

   this.filter = new ComboBox( this );
   for ( var i = 0; i < this.suggestions.length; ++i )
      this.filter.addItem( "Filter " + this.suggestions[i].filter );
   var filterLabel = new Label( this );
   filterLabel.text = "Show:";
   filterLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   var filterRow = new HorizontalSizer;
   filterRow.spacing = 6;
   filterRow.add( filterLabel );
   filterRow.add( this.filter );
   filterRow.addStretch();

   this.plot = new Control( this );
   this.plot.setScaledMinSize( 760, 400 );
   var plot = this.plot, reported = false;
   this.plot.onPaint = function()
   {
      var g = new Graphics( plot );
      try
      {
         secPaintPlot( g, plot.width, plot.height, plot.font, plot.displayPixelRatio, self.model );
      }
      catch ( e )
      {
         if ( !reported )
            console.warningln( "The graph could not be drawn: " + e );
         reported = true;
      }
      g.end();
   };

   this.note = new Label( this );
   this.note.frameStyle = FrameStyle_Box;
   this.note.margin = 6;
   this.note.wordWrapping = true;
   this.note.useRichText = true;

   this.select = function( index )
   {
      var s = self.suggestions[index];
      var lines = secSuggestionLines( s );
      var html = "<p><b>" + secHtml( lines[0] ) + "</b>";
      for ( var k = 1; k < lines.length; ++k )
         html += "<br>" + secHtml( lines[k] );
      html += "</p><p>Each curve shows how much of the signal-to-noise ratio of one single long " +
         "exposure a stack keeps at that sub length. The horizontal dashed lines mark your target multiples. " +
         "The suggestion holds for the sky as it was in " +
         (s.frames > 1 ? "these " + s.frames + " frames" : "this frame") +
         "; measure again when the Moon or the target's altitude changes.</p>";
      self.note.text = html;
      self.model = secPlotModel( s );
      plot.update();
   };
   this.filter.onItemSelected = function( index ) { self.select( index ); };

   this.closeButton = new PushButton( this );
   this.closeButton.text = "Close";
   this.closeButton.onClick = function() { self.ok(); };
   var buttons = new HorizontalSizer;
   buttons.addStretch();
   buttons.add( this.closeButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( filterRow );
   this.sizer.add( this.plot, 100 );
   this.sizer.add( this.note );
   this.sizer.add( buttons );
   this.select( 0 );
   this.adjustToContents();
}
SecGraphDialog.prototype = new Dialog;

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

// ============================================================================
// Camera database: saved camera measurements, kept in PixInsight's settings
// ============================================================================

function secIsNumber( x )
{
   return typeof x == "number" && isFinite( x );
}

/*
 * Checks a camera measurement that was read back from text and repairs what
 * JSON cannot carry (NaN is stored as null). Returns it, or null when it is
 * not a measurement this version can use.
 */
function secCheckCamera( c )
{
   if ( !c || c.format != 1 || !c.layout || !c.layout.names || !c.layout.map || !c.biasLevel ||
        !c.rnE || !c.rnRmsE || !(c.gain > 0) || !(c.gainCamera > 0) || !(c.step >= 1) ||
        !(c.width > 0) || !(c.height > 0) )
      return null;
   var n = c.layout.names.length;
   if ( c.biasLevel.length != n || c.rnE.length != n || c.rnRmsE.length != n )
      return null;
   if ( c.gainPerChannel )
      for ( var i = 0; i < c.gainPerChannel.length; ++i )
         if ( c.gainPerChannel[i] === null )
            c.gainPerChannel[i] = NaN;
   if ( c.rnSpreadPct === null || c.rnSpreadPct === undefined )
      c.rnSpreadPct = NaN;
   if ( c.gainSpreadPct === null || c.gainSpreadPct === undefined )
      c.gainSpreadPct = NaN;
   if ( !c.warnings )
      c.warnings = [];
   return c;
}

// A name that is not in taken[]: the name itself, or with (2), (3), ... added.
function secUniqueName( name, taken )
{
   if ( taken.indexOf( name ) < 0 )
      return name;
   for ( var k = 2; ; ++k )
      if ( taken.indexOf( name + " (" + k + ")" ) < 0 )
         return name + " (" + k + ")";
}

// A name for a camera measurement from what its bias frames say about it.
function secCameraName( camera, taken )
{
   var name = (camera.instrument && camera.instrument != "") ? camera.instrument :
      ((camera.layout.cfa ? "Colour" : "Mono") + " camera " + camera.width + " x " + camera.height);
   if ( camera.gainSetting && camera.gainSetting != "" )
      name += ", gain " + camera.gainSetting;
   if ( camera.offsetSetting && camera.offsetSetting != "" )
      name += ", offset " + camera.offsetSetting;
   var t = secNum( camera.temperature );
   if ( isFinite( t ) )
      name += ", " + Math.round( t ) + " °C";
   return secUniqueName( name, taken );
}

// The saved cameras as [{ name, camera }].
function secLoadCameras()
{
   var list = [], names = [];
   try
   {
      var raw = JSON.parse( secLoadSetting( "cameras", "" ) );
      for ( var i = 0; i < raw.length; ++i )
      {
         var camera = secCheckCamera( raw[i].camera );
         if ( camera != null && raw[i].name )
         {
            var name = secUniqueName( String( raw[i].name ), names );
            names.push( name );
            list.push( { name: name, camera: camera } );
         }
      }
   }
   catch ( e ) {}
   if ( list.length == 0 )
      try
      {
         // the single measurement that an earlier version kept
         var old = secCheckCamera( JSON.parse( secLoadSetting( "camera", "" ) ) );
         if ( old != null )
            list.push( { name: secCameraName( old, [] ), camera: old } );
      }
      catch ( e2 ) {}
   return list;
}

function secSaveCameras( list )
{
   secSaveSetting( "cameras", JSON.stringify( list ) );
}

// A list of file paths kept in the settings.
function secLoadList( key )
{
   try
   {
      var a = JSON.parse( secLoadSetting( key, "[]" ) ), out = [];
      for ( var i = 0; i < a.length; ++i )
         out.push( String( a[i] ) );
      return out;
   }
   catch ( e ) {}
   return [];
}

// One camera as the text of a file that can be kept or passed on.
function secCameraFileText( entry )
{
   return JSON.stringify( { file: "SubExposureCalculator camera", version: 1, name: entry.name,
                            camera: entry.camera }, null, 2 ) + "\n";
}

// The reverse. Throws an Error that says what is wrong with the text.
function secCameraFromFileText( text )
{
   var o = null;
   try
   {
      o = JSON.parse( text );
   }
   catch ( e )
   {
      throw new Error( "This is not a camera file saved by " + SEC_TITLE + "." );
   }
   if ( !o || o.file != "SubExposureCalculator camera" )
      throw new Error( "This is not a camera file saved by " + SEC_TITLE + "." );
   var camera = secCheckCamera( o.camera );
   if ( camera == null )
      throw new Error( "This camera file is incomplete or comes from a newer version of " + SEC_TITLE + "." );
   return { name: secTrim( o.name || "" ) || secCameraName( camera, [] ), camera: camera };
}

// One line that describes a saved camera, shown under the pull-down.
function secCameraSummary( camera )
{
   var s = (camera.layout.cfa ? "Colour " + camera.layout.pattern : "Mono") + ", " + camera.width + " x " + camera.height;
   if ( camera.step > 1 )
      s += ", " + camera.bits + " bit";
   s += ". Read noise " + secFmt( secMedianOf( camera.rnE ), 2 ) + " e- (typical pixel), " +
      secFmt( secMedianOf( camera.rnRmsE ), 2 ) + " e- (all pixels). Gain " + secFmt( camera.gain, 4 ) +
      " e-/ADU, " + camera.gainSource + ".";
   if ( camera.measuredAt )
      s += " Measured " + camera.measuredAt + ".";
   return s;
}

// Local date and time as "2026-11-12 21:05".
function secTimeStamp( d )
{
   function two( n ) { return (n < 10 ? "0" : "") + n; }
   return d.getFullYear() + "-" + two( d.getMonth() + 1 ) + "-" + two( d.getDate() ) + " " +
      two( d.getHours() ) + ":" + two( d.getMinutes() );
}

// A saved camera as rich text for the results label, with a closing note.
function secCameraHtml( entry, note )
{
   var camera = entry.camera;
   var lines = secCameraText( { camera: camera, cameraName: entry.name } );
   if ( camera.warnings && camera.warnings.length > 0 )
      lines.push( camera.warnings.length + " warning(s) when it was measured. First: " + camera.warnings[0] );
   for ( var i = 0; i < lines.length; ++i )
      lines[i] = secHtml( lines[i] );
   return "<p>" + lines.join( "<br>" ) + "</p><p>" + note + "</p>";
}

// ============================================================================
// The window that measures a camera
// ============================================================================

/*
 * taken[] are the names already in the database. After a successful
 * measurement, entry is { name, camera } and the dialog closes as accepted.
 */
function SecCameraDialog( taken )
{
   this.__base__ = Dialog;
   this.__base__();
   var self = this;
   this.windowTitle = SEC_TITLE + ": measure a camera";
   this.taken = taken || [];
   this.entry = null;
   this.loader = null; // a test can supply frames here; PixInsight reads them from disk
   this.biasPaths = secLoadList( "cameraBias" );
   this.flatPaths = secLoadList( "cameraFlats" );

   var labelWidth = this.font.width( "Conversion gain:" ) + 12;
   function makeLabel( text )
   {
      var l = new Label( self );
      l.text = text;
      l.textAlignment = TextAlign_Right | TextAlign_VertCenter;
      l.setFixedWidth( labelWidth );
      return l;
   }

   // A list of files with Add, Remove and Clear. paths[] is changed in place.
   function makeFileList( paths, caption, height )
   {
      var tree = new TreeBox( self );
      tree.alternateRowColor = true;
      tree.rootDecoration = false;
      tree.multipleSelection = true;
      tree.numberOfColumns = 1;
      tree.headerVisible = false;
      tree.setScaledMinSize( 660, height );
      function refresh()
      {
         tree.clear();
         for ( var i = 0; i < paths.length; ++i )
         {
            var node = new TreeBoxNode( tree );
            node.setText( 0, paths[i] );
         }
      }
      var add = new PushButton( self );
      add.text = "Add...";
      add.onClick = function()
      {
         var d = new OpenFileDialog;
         d.multipleSelections = true;
         d.caption = caption;
         d.filters = SEC_FILE_FILTERS;
         if ( d.execute() )
         {
            var names = d.fileNames;
            for ( var i = 0; i < names.length; ++i )
               if ( paths.indexOf( names[i] ) < 0 )
                  paths.push( names[i] );
            refresh();
         }
      };
      var remove = new PushButton( self );
      remove.text = "Remove";
      remove.onClick = function()
      {
         var sel = tree.selectedNodes, idx = [];
         for ( var i = 0; i < sel.length; ++i )
            idx.push( tree.childIndex( sel[i] ) );
         idx.sort( function( a, b ) { return b - a; } );
         for ( var j = 0; j < idx.length; ++j )
            if ( idx[j] >= 0 )
               paths.splice( idx[j], 1 );
         refresh();
      };
      var clear = new PushButton( self );
      clear.text = "Clear";
      clear.onClick = function()
      {
         paths.length = 0;
         refresh();
      };
      var buttons = new VerticalSizer;
      buttons.spacing = 4;
      buttons.add( add );
      buttons.add( remove );
      buttons.add( clear );
      buttons.addStretch();
      var s = new HorizontalSizer;
      s.spacing = 6;
      s.add( tree, 100 );
      s.add( buttons );
      refresh();
      return { sizer: s, tree: tree, add: add, remove: remove, clear: clear, refresh: refresh };
   }

   // ---- What this is ----
   this.intro = new Label( this );
   this.intro.frameStyle = FrameStyle_Box;
   this.intro.margin = 6;
   this.intro.wordWrapping = true;
   this.intro.useRichText = true;
   this.intro.text = "<p>A camera here means one camera at <b>one gain, offset and binning</b>. " +
      "Its bias level, read noise and conversion gain are measured from <b>raw</b> frames and saved, " +
      "so that later you only choose it from the list. The more frames you give, the firmer the " +
      "result: they are used two at a time and the median over the pairs is taken. Flat frames may " +
      "come from any mix of filters, because the gain belongs to the camera and not to the filter.</p>";

   // ---- Name ----
   this.name = new Edit( this );
   this.name.toolTip = "The name in the camera list. Leave it empty to name the camera after what " +
      "its frames say: camera, gain, offset and temperature. An existing name replaces that camera.";
   var nameRow = new HorizontalSizer;
   nameRow.spacing = 6;
   nameRow.add( makeLabel( "Name:" ) );
   nameRow.add( this.name, 100 );

   // ---- Bias frames ----
   this.biasList = makeFileList( this.biasPaths, "Select raw bias frames", 110 );
   this.biasGroup = new GroupBox( this );
   this.biasGroup.title = "Raw bias frames: two or more single frames, not a master";
   this.biasGroup.sizer = new VerticalSizer;
   this.biasGroup.sizer.margin = 6;
   this.biasGroup.sizer.add( this.biasList.sizer );

   // ---- Conversion gain ----
   this.gainMode = new ComboBox( this );
   this.gainMode.addItem( "Measure from raw flat frames" );
   this.gainMode.addItem( "Enter a value" );
   this.gainMode.currentItem = (secLoadSetting( "gainMode", "manual" ) == "flats") ? 0 : 1;
   this.manualGain = new Edit( this );
   this.manualGain.text = secLoadSetting( "manualGain", "0.25" );
   this.manualGain.setFixedWidth( this.font.width( "0000000000000000" ) );
   this.manualGain.toolTip = "Electrons per ADU as stored in the file (16 bit scale) at the gain setting " +
      "you use. Charts for 12 and 14 bit cameras usually give electrons per ADU of the camera itself: " +
      "divide such a value by 16 (12 bit) or 4 (14 bit) when the files are scaled to 16 bit. " +
      "The results show both figures, so you can check the one you typed.";
   var gainLabel = new Label( this );
   gainLabel.text = "e-/ADU:";
   gainLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   var gainRow = new HorizontalSizer;
   gainRow.spacing = 6;
   gainRow.add( makeLabel( "Conversion gain:" ) );
   gainRow.add( this.gainMode );
   gainRow.add( gainLabel );
   gainRow.add( this.manualGain );
   gainRow.addStretch();

   this.flatList = makeFileList( this.flatPaths, "Select raw flat frames", 110 );
   this.updateGainMode = function()
   {
      var flats = self.gainMode.currentItem == 0;
      self.flatList.tree.enabled = self.flatList.add.enabled = self.flatList.remove.enabled =
         self.flatList.clear.enabled = flats;
      self.manualGain.enabled = !flats;
   };
   this.gainMode.onItemSelected = function() { self.updateGainMode(); };
   this.updateGainMode();

   this.gainGroup = new GroupBox( this );
   this.gainGroup.title = "Conversion gain: raw flat frames in pairs, any filters, or a typed value";
   this.gainGroup.sizer = new VerticalSizer;
   this.gainGroup.sizer.margin = 6;
   this.gainGroup.sizer.spacing = 4;
   this.gainGroup.sizer.add( gainRow );
   this.gainGroup.sizer.add( this.flatList.sizer );

   // ---- Sensor ----
   this.sensor = new ComboBox( this );
   for ( var s = 0; s < SEC_SENSOR_LABELS.length; ++s )
      this.sensor.addItem( SEC_SENSOR_LABELS[s] );
   this.sensor.currentItem = Math.max( 0, SEC_SENSORS.indexOf( secLoadSetting( "sensor", "auto" ) ) );
   this.sensor.toolTip = "Auto reads the BAYERPAT keyword of the bias frames. Set Mono or a Bayer " +
      "pattern by hand if the keyword is missing or wrong.";
   var sensorRow = new HorizontalSizer;
   sensorRow.spacing = 6;
   sensorRow.add( makeLabel( "Sensor:" ) );
   sensorRow.add( this.sensor );
   sensorRow.addStretch();

   // ---- Progress and buttons ----
   this.status = new Label( this );
   this.status.text = "";

   this.measureButton = new PushButton( this );
   this.measureButton.text = "Measure and save";
   this.measureButton.defaultButton = true;
   this.measureButton.onClick = function() { self.measure(); };
   this.cancelButton = new PushButton( this );
   this.cancelButton.text = "Cancel";
   this.cancelButton.onClick = function() { self.cancel(); };
   var buttons = new HorizontalSizer;
   buttons.spacing = 6;
   buttons.add( this.status, 100 );
   buttons.add( this.measureButton );
   buttons.add( this.cancelButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( this.intro );
   this.sizer.add( nameRow );
   this.sizer.add( this.biasGroup, 50 );
   this.sizer.add( this.gainGroup, 50 );
   this.sizer.add( sensorRow );
   this.sizer.add( buttons );
   this.adjustToContents();

   // ---- Actions ----
   this.fail = function( message )
   {
      (new MessageBox( message, SEC_TITLE, StdIcon_Error, StdButton_Ok )).execute();
   };

   this.measure = function()
   {
      var flats = self.gainMode.currentItem == 0;
      var p = {
         biasFrames: self.biasPaths.slice( 0 ),
         gainMode: flats ? "flats" : "manual",
         flatFrames: self.flatPaths.slice( 0 ),
         manualGain: parseFloat( self.manualGain.text.replace( ",", "." ) ),
         sensor: SEC_SENSORS[self.sensor.currentItem]
      };
      if ( self.loader != null )
         p.loader = self.loader;
      if ( p.biasFrames.length < 2 )
         return self.fail( "Please add at least two raw bias frames." );
      if ( flats && p.flatFrames.length < 2 )
         return self.fail( "Please add at least two raw flat frames, or choose \"Enter a value\"." );
      if ( !flats && !(p.manualGain > 0) )
         return self.fail( "Please enter the conversion gain in e-/ADU." );

      secSaveSetting( "cameraBias", JSON.stringify( self.biasPaths ) );
      secSaveSetting( "cameraFlats", JSON.stringify( self.flatPaths ) );
      secSaveSetting( "gainMode", p.gainMode );
      secSaveSetting( "manualGain", self.manualGain.text );
      secSaveSetting( "sensor", p.sensor );

      self.status.text = "Measuring...";
      processEvents();
      var camera = null;
      try
      {
         camera = secMeasureCamera( p, function( message )
         {
            console.writeln( message );
            console.flush();
            self.status.text = message;
            processEvents();
         } );
      }
      catch ( e )
      {
         self.status.text = "The measurement stopped with an error.";
         return self.fail( String( e.message || e ) );
      }
      camera.measuredAt = secTimeStamp( new Date );
      var name = secTrim( self.name.text );
      self.entry = { name: (name != "") ? name : secCameraName( camera, self.taken ), camera: camera };
      self.status.text = "Saved as " + self.entry.name;
      self.ok();
   };
}
SecCameraDialog.prototype = new Dialog;

function SecDialog()
{
   this.__base__ = Dialog;
   this.__base__();
   var self = this;
   this.windowTitle = SEC_TITLE + " " + SEC_VERSION;
   this.lightPaths = [];
   this.results = null;
   this.cameras = secLoadCameras(); // the camera database: [{ name, camera }]
   this.loader = null;              // a test can supply frames here; PixInsight reads them from disk

   var labelWidth = this.font.width( "Site longitude (°, east +):" ) + 12;

   function makeLabel( text )
   {
      var l = new Label( self );
      l.text = text;
      l.textAlignment = TextAlign_Right | TextAlign_VertCenter;
      l.setFixedWidth( labelWidth );
      return l;
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
      "to make read noise insignificant. Follow steps 1 to 3, then press Calculate. " +
      "Press Help for the method and the theory.</p>";

   // ---- Step 1: camera ----
   this.cameraCombo = new ComboBox( this );
   this.cameraCombo.toolTip = "The camera measurement used for the calculation: bias level, read noise " +
      "and conversion gain of one camera at one gain, offset and binning. Press New to measure one " +
      "from bias and flat frames. Measure a new one after changing gain, offset or binning.";
   this.cameraCombo.onItemSelected = function( index ) { self.selectCamera( index ); };

   this.newCameraButton = new PushButton( this );
   this.newCameraButton.text = "New...";
   this.newCameraButton.toolTip = "Measure a camera from raw bias frames and flat frames (or a typed gain) " +
      "and add it to this list.";
   this.newCameraButton.onClick = function()
   {
      var d = new SecCameraDialog( self.cameraNames() );
      d.loader = self.loader;
      if ( d.execute() && d.entry != null )
         self.addCamera( d.entry );
   };

   this.deleteCameraButton = new PushButton( this );
   this.deleteCameraButton.text = "Delete";
   this.deleteCameraButton.toolTip = "Remove the selected camera from this list.";
   this.deleteCameraButton.onClick = function() { self.deleteCamera(); };

   this.importCameraButton = new PushButton( this );
   this.importCameraButton.text = "Import...";
   this.importCameraButton.toolTip = "Add a camera from a file made with Export.";
   this.importCameraButton.onClick = function()
   {
      var d = new OpenFileDialog;
      d.caption = "Select a camera file";
      d.filters = [["Camera files", "*.json"], ["All files", "*"]];
      if ( d.execute() )
         self.importCamera( d.fileName );
   };

   this.exportCameraButton = new PushButton( this );
   this.exportCameraButton.text = "Export...";
   this.exportCameraButton.toolTip = "Save the selected camera as a file, to keep it or to use it on " +
      "another computer.";
   this.exportCameraButton.onClick = function()
   {
      if ( self.currentEntry() == null )
         return;
      var d = new SaveFileDialog;
      d.caption = "Save the camera as a file";
      d.filters = [["Camera files", "*.json"]];
      if ( d.execute() )
      {
         var path = d.fileName;
         if ( !/\.json$/i.test( path ) )
            path += ".json";
         self.exportCamera( path );
      }
   };

   var cameraRow = new HorizontalSizer;
   cameraRow.spacing = 6;
   cameraRow.add( makeLabel( "Camera:" ) );
   cameraRow.add( this.cameraCombo, 100 );
   cameraRow.add( this.newCameraButton );
   cameraRow.add( this.deleteCameraButton );
   cameraRow.add( this.importCameraButton );
   cameraRow.add( this.exportCameraButton );

   this.cameraSummary = new Label( this );
   this.cameraSummary.wordWrapping = true;
   var summaryRow = new HorizontalSizer;
   summaryRow.spacing = 6;
   summaryRow.add( makeLabel( "" ) );
   summaryRow.add( this.cameraSummary, 100 );

   this.cameraGroup = new GroupBox( this );
   this.cameraGroup.title = "Step 1: camera (measured once from bias and flat frames, then chosen here)";
   this.cameraGroup.sizer = new VerticalSizer;
   this.cameraGroup.sizer.margin = 6;
   this.cameraGroup.sizer.spacing = 4;
   this.cameraGroup.sizer.add( cameraRow );
   this.cameraGroup.sizer.add( summaryRow );

   // ---- Step 2: lights ----
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
   this.lightsGroup.title = "Step 2: raw light frames (uncalibrated, one or more per filter)";
   this.lightsGroup.sizer = new HorizontalSizer;
   this.lightsGroup.sizer.margin = 6;
   this.lightsGroup.sizer.spacing = 6;
   this.lightsGroup.sizer.add( this.lightsTree, 100 );
   this.lightsGroup.sizer.add( lightButtons );

   // ---- Step 3: options ----
   this.bgMode = new ComboBox( this );
   this.bgMode.addItem( "Darkest tiles (copes with nebulosity)" );
   this.bgMode.addItem( "Whole frame median" );
   this.bgMode.addItem( "Preview (your own background)" );
   var savedBgMode = secLoadSetting( "bgMode", "tiles" );
   this.bgMode.currentItem = (savedBgMode == "region") ? 2 : ((savedBgMode == "frame") ? 1 : 0);
   var bgToolTip = "How the sky background of a light frame is found. With Preview, the rectangle " +
      "of a preview you drew is used: open a raw light frame, draw a preview on empty sky (100 x 100 " +
      "pixels or more, away from the vignetted corners), then start this script and choose the " +
      "preview here. The same rectangle is " +
      "used in every light frame in the list, so they should share the same framing.";
   this.bgMode.toolTip = bgToolTip;

   // previews of the images that are open; only used with the Preview choice
   this.bgView = new ViewList( this );
   this.bgView.getPreviews();
   this.bgView.toolTip = bgToolTip;
   this.bgView.onViewSelected = function( view )
   {
      // the image the preview was drawn on is measured too
      if ( view && !view.isNull && view.isPreview )
      {
         var path = view.window.filePath;
         if ( path != "" && self.lightPaths.indexOf( path ) < 0 )
         {
            self.lightPaths.push( path );
            self.refreshLights();
         }
      }
   };
   this.updateBgMode = function()
   {
      self.bgView.enabled = self.bgMode.currentItem == 2;
   };
   this.bgMode.onItemSelected = function() { self.updateBgMode(); };
   this.updateBgMode();
   var bgRow = new HorizontalSizer;
   bgRow.spacing = 6;
   bgRow.add( makeLabel( "Sky background:" ) );
   bgRow.add( this.bgMode );
   bgRow.add( this.bgView );
   bgRow.addStretch();

   this.targets = makeEditRow( "Target multiples:", "targets", "3, 5, 10",
      "Multiples of read noise squared to calculate sub-exposure times for, separated by commas. " +
      "3 gives 87%, 5 gives 91% and 10 gives 95% of the ideal signal-to-noise ratio. " +
      "The middle value is used for the suggested sub-exposure; the lowest and highest mark " +
      "the range shown with it." );
   this.fallback = makeEditRow( "Exposure if missing (s):", "fallback", "",
      "Used only for light frames whose header has no EXPTIME or EXPOSURE keyword." );
   this.siteLat = makeEditRow( "Site latitude (°, north +):", "siteLat", "",
      "Optional. Used for Moon altitude when the frames have no SITELAT keyword." );
   this.siteLon = makeEditRow( "Site longitude (°, east +):", "siteLon", "",
      "Optional. Used for Moon altitude when the frames have no SITELONG keyword." );

   var optLeft = new VerticalSizer;
   optLeft.spacing = 4;
   optLeft.add( bgRow );
   optLeft.add( this.targets.sizer );
   var optRight = new VerticalSizer;
   optRight.spacing = 4;
   optRight.add( this.fallback.sizer );
   optRight.add( this.siteLat.sizer );
   optRight.add( this.siteLon.sizer );

   this.optionsGroup = new GroupBox( this );
   this.optionsGroup.title = "Step 3: options";
   this.optionsGroup.sizer = new HorizontalSizer;
   this.optionsGroup.sizer.margin = 6;
   this.optionsGroup.sizer.spacing = 12;
   this.optionsGroup.sizer.add( optLeft );
   this.optionsGroup.sizer.add( optRight );
   this.optionsGroup.sizer.addStretch();

   // ---- Results ----
   this.cameraLabel = new Label( this );
   this.cameraLabel.wordWrapping = true;
   this.cameraLabel.useRichText = true;
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

   this.graphButton = new PushButton( this );
   this.graphButton.text = "Graph...";
   this.graphButton.toolTip = "Shows stack efficiency against sub-exposure time for each channel, " +
      "with the suggested sub-exposure marked.";
   this.graphButton.enabled = false;
   this.graphButton.onClick = function()
   {
      if ( self.results != null && self.results.suggestions.length > 0 )
         (new SecGraphDialog( self.results )).execute();
   };

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
   buttons.add( this.graphButton );
   buttons.add( this.csvButton );
   buttons.add( this.closeButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( this.header );
   this.sizer.add( this.cameraGroup );
   this.sizer.add( this.lightsGroup );
   this.sizer.add( this.optionsGroup );
   this.sizer.add( this.resultsGroup, 100 );
   this.sizer.add( buttons );

   // ---- Actions ----
   this.fail = function( message )
   {
      (new MessageBox( message, SEC_TITLE, StdIcon_Error, StdButton_Ok )).execute();
   };

   this.confirm = function( question )
   {
      return (new MessageBox( question, SEC_TITLE, StdIcon_Question, StdButton_Yes, StdButton_No )).execute() == StdButton_Yes;
   };

   this.progress = function( message )
   {
      console.writeln( message );
      console.flush();
      self.cameraLabel.text = message;
      processEvents();
   };

   this.clearResults = function()
   {
      self.results = null;
      self.csvButton.enabled = self.graphButton.enabled = false;
      self.resultsTree.clear();
   };

   // ---- The camera database ----
   this.cameraIndex = -1;

   this.cameraNames = function()
   {
      var names = [];
      for ( var i = 0; i < self.cameras.length; ++i )
         names.push( self.cameras[i].name );
      return names;
   };

   this.currentEntry = function()
   {
      return (self.cameraIndex >= 0 && self.cameraIndex < self.cameras.length) ? self.cameras[self.cameraIndex] : null;
   };

   // Makes the camera with this index the one in use. Results on screen
   // belong to the camera they were calculated with, so they are cleared.
   this.selectCamera = function( index )
   {
      var entry = (index >= 0 && index < self.cameras.length) ? self.cameras[index] : null;
      self.cameraIndex = (entry != null) ? index : -1;
      self.deleteCameraButton.enabled = self.exportCameraButton.enabled = entry != null;
      self.clearResults();
      if ( entry == null )
      {
         self.cameraSummary.text = "No camera yet. Press New to measure one from raw bias frames and flat frames.";
         self.cameraLabel.text = "Results appear here after you press Calculate.";
         return;
      }
      secSaveSetting( "cameraName", entry.name );
      self.cameraSummary.text = secCameraSummary( entry.camera );
      self.cameraLabel.text = secCameraHtml( entry, "Add light frames and press Calculate." );
   };

   // Fills the pull-down again and selects the camera with this name, or the
   // first one.
   this.refreshCameras = function( name )
   {
      self.cameraCombo.clear();
      var index = (self.cameras.length > 0) ? 0 : -1;
      for ( var i = 0; i < self.cameras.length; ++i )
      {
         self.cameraCombo.addItem( self.cameras[i].name );
         if ( self.cameras[i].name == name )
            index = i;
      }
      if ( index >= 0 )
         self.cameraCombo.currentItem = index;
      self.selectCamera( index );
   };

   // Adds a camera, or replaces the one with the same name, and selects it.
   this.addCamera = function( entry )
   {
      var at = self.cameraNames().indexOf( entry.name );
      if ( at >= 0 )
         self.cameras[at] = entry;
      else
         self.cameras.push( entry );
      secSaveCameras( self.cameras );
      self.refreshCameras( entry.name );
   };

   this.deleteCamera = function()
   {
      var entry = self.currentEntry();
      if ( entry == null || !self.confirm( "Remove the camera \"" + entry.name + "\" from the list? " +
              "The frames it was measured from are not touched." ) )
         return;
      self.cameras.splice( self.cameraIndex, 1 );
      secSaveCameras( self.cameras );
      self.refreshCameras( "" );
   };

   this.exportCamera = function( path )
   {
      var entry = self.currentEntry();
      if ( entry == null )
         return;
      try
      {
         File.writeTextFile( path, secCameraFileText( entry ) );
         console.writeln( "Camera saved to " + path );
      }
      catch ( e )
      {
         self.fail( "The camera file could not be written. " + String( e.message || e ) );
      }
   };

   this.importCamera = function( path )
   {
      var entry = null;
      try
      {
         entry = secCameraFromFileText( File.readTextFile( path ) );
      }
      catch ( e )
      {
         return self.fail( String( e.message || e ) );
      }
      entry.name = secUniqueName( entry.name, self.cameraNames() );
      self.addCamera( entry );
   };

   // ---- The calculation ----
   // Everything entered for the light frames, in the form the engine takes.
   this.readInputs = function()
   {
      var mode = self.bgMode.currentItem;
      var p = {
         lights: self.lightPaths.slice( 0 ),
         bgMode: (mode == 2) ? "region" : ((mode == 1) ? "frame" : "tiles"),
         bgRegion: null,
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
      if ( self.loader != null )
         p.loader = self.loader;
      return p;
   };

   // Measures the light frames against the camera chosen in step 1.
   this.calculate = function()
   {
      var p = self.readInputs();
      var entry = self.currentEntry();
      if ( entry == null )
         return self.fail( "Step 1: please choose a camera, or press New to measure one from raw " +
            "bias frames and flat frames." );
      if ( p.lights.length == 0 )
         return self.fail( "Step 2: please add at least one raw light frame." );
      if ( p.targets.length == 0 )
         return self.fail( "Step 3: please enter at least one target multiple, for example 3, 5, 10." );

      // the user's own background: the rectangle of the chosen preview
      if ( p.bgMode == "region" )
      {
         var view = self.bgView.currentView;
         if ( !view || view.isNull || !view.isPreview )
            return self.fail( "Step 3: please choose the preview that marks your background. It has " +
               "to exist before this script starts: open a raw light frame, draw a preview on " +
               "empty sky, then start the script again." );
         var rect = view.window.previewRect( view );
         var image = view.window.mainView.image;
         if ( image.width != entry.camera.width || image.height != entry.camera.height )
            return self.fail( "The preview belongs to an image of " + image.width + " x " + image.height +
               " pixels, but the frames of this camera are " + entry.camera.width + " x " +
               entry.camera.height + ". Choose a preview on a raw light frame from this camera." );
         p.bgRegion = { x0: rect.x0, y0: rect.y0, x1: rect.x0 + rect.width, y1: rect.y0 + rect.height,
                        source: view.fullId };
      }

      secSaveSetting( "bgMode", p.bgMode );
      secSaveSetting( "targets", self.targets.edit.text );
      secSaveSetting( "fallback", self.fallback.edit.text );
      secSaveSetting( "siteLat", self.siteLat.edit.text );
      secSaveSetting( "siteLon", self.siteLon.edit.text );

      p.camera = entry.camera;
      self.cameraLabel.text = "Working...";
      processEvents();
      var r = null;
      try
      {
         r = secCompute( p, self.progress );
      }
      catch ( e )
      {
         self.cameraLabel.text = "The calculation stopped with an error.";
         return self.fail( String( e.message || e ) );
      }
      r.cameraName = entry.name;

      self.results = r;
      self.csvButton.enabled = true;
      self.graphButton.enabled = r.suggestions.length > 0;
      secConsoleReport( r );
      self.showResults( r );
   };

   this.showResults = function( r )
   {
      var lines = secCameraText( r ), q;
      if ( r.background.mode == "region" )
         lines.push( "Sky background from " + secBackgroundText( r.background ) );
      if ( r.warnings.length > 0 )
         lines.push( r.warnings.length + " warning(s), see the Process Console. First: " + r.warnings[0] );
      for ( q = 0; q < lines.length; ++q )
         lines[q] = secHtml( lines[q] );
      var html = "";
      if ( r.suggestions.length > 0 )
      {
         // one short entry per filter; the Graph window and the console have the detail
         var parts = [];
         for ( q = 0; q < r.suggestions.length; ++q )
         {
            var sg = r.suggestions[q], last = sg.targets.length - 1;
            var part = (sg.filter == "(none)" ? "" : secHtml( sg.filter ) + " ") +
               "<b>about " + secSuggestionSpan( sg ) + "</b>";
            if ( sg.goal > sg.targets[0] && sg.goal < sg.targets[last] )
               part += " (worthwhile from " + secFmtTime( sg.times[0] ) + ", little gain beyond " +
                  secFmtTime( sg.all.times[last] ) + ")";
            parts.push( part );
         }
         html += "<p><b>Suggested sub-exposure:</b> " + parts.join( "; " ) +
            ". Press Graph for the details.</p>";
      }
      self.cameraLabel.text = html + "<p>" + lines.join( "<br>" ) + "</p>";

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

   // start with the camera that was used last
   this.refreshCameras( secLoadSetting( "cameraName", "" ) );
   this.adjustToContents();
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
