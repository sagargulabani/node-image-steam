var url = require('url');
var _ = require('lodash');
var EventEmitter = require('events').EventEmitter;
var helpers = require('../helpers');
var defaults = require('./router-defaults');
var mime = require('mime');

module.exports = Router;

function Router(options) {
  if (!(this instanceof Router)) {
    return new Router(options);
  }

  EventEmitter.call(this);

  this.allOptions = options;
  this.appOptions =
    (options.storage && options.storage.app && options.storage.app) || {};
  this.options = _.merge({}, defaults, options.router || {});
  if (this.options.canDisableCache === undefined) {
    this.canDisableCache = process.env.NODE_ENV !== 'production';
  } else {
    this.canDisableCache = this.options.canDisableCache;
  }

  if (/^win/.test(process.platform)) {
    // force disable WebP on Windows
    this.options.supportWebP = false;
  }
}

var p = (Router.prototype = new EventEmitter());

/* FORMAT
  {path}{pathDelimiter}{cmd1}{cmdValDelimiter}{cmd1Param1Key}{paramValDelimiter}{cmd1Param1Value}{paramKeyDelimiter}{cmdKeyDelimiter}{signatureDelimiter}{signature}?{queryString}
*/

p.getInfo = function (req, opts) {
  const urlInfo = url.parse(req.url, true);
  const appName = urlInfo.pathname.split('/')[1];
  const appOptions = this.appOptions[appName] || {};
  const routerOptions = appOptions.router;
  const options = _.merge({}, this.options, routerOptions || {});

  let originalSteps, hashFromOptimizedOriginal, hqOriginalSteps;
  if (typeof options.originalSteps === 'object') {
    originalSteps = this.getStepsFromObject(options.originalSteps, options);
    hashFromOptimizedOriginal =
      helpers.imageSteps.getHashFromSteps(originalSteps);
  }

  if (typeof options.hqOriginalSteps === 'object') {
    hqOriginalSteps = this.getStepsFromObject(options.hqOriginalSteps, options);
  }

  var routeInfo = {
    urlInfo: urlInfo,
    originalSteps: originalSteps,
    hashFromOptimizedOriginal: hashFromOptimizedOriginal,
    hqOriginalSteps: hqOriginalSteps,
  };

  var signatureParts = routeInfo.urlInfo.pathname.split(
    options.signatureDelimiter
  );
  routeInfo.toSign = signatureParts[0];
  routeInfo.signature = signatureParts[1];

  // encoding does not belong here -- rely on storage providers to encode as necessary
  routeInfo.urlInfo.pathname = decodeURI(routeInfo.urlInfo.pathname);
  routeInfo.isCachable =
    !this.canDisableCache || // cannot disable cache
    routeInfo.urlInfo.query.cache !== 'false'; // or request isn't disabling cache

  routeInfo.optimized = routeInfo.urlInfo.query.optimized === 'true';

  // Append search query param to pathname if pathDelimiter = '?'
  if (options.pathDelimiter === '?' && routeInfo.urlInfo.search) {
    routeInfo.urlInfo.pathname = `${routeInfo.urlInfo.pathname}${routeInfo.urlInfo.search}`;
  }

  // Run the preprocessor if provided in the configuration.
  if (typeof options.beforeProcess === 'function') {
    options.beforeProcess(routeInfo, options);
  }

  // break apart imagePath from imageSteps from queryParams
  var pathParts = routeInfo.urlInfo.pathname
    .split(options.signatureDelimiter)[0]
    .split(options.pathDelimiter);
  routeInfo.originalPath = pathParts[0].substr(1); // remove `/` prefix from path

  routeInfo.imageSteps = getImageStepsFromRoute.call(this, pathParts[1]);
  if (routeInfo.imageSteps.length === 0) {
    // attempt to determine content type only if no image steps are provided
    routeInfo.contentType = getContentType(req, routeInfo);
    if (routeInfo.contentType) {
      // we've determined this is not an image, use as-is
      return routeInfo;
    }
  }

  if (routeInfo.imageSteps.length > 0 && routeInfo.imageSteps[0].command) {
    // not an image step, but instead a command
    routeInfo.command = routeInfo.imageSteps[0];
    routeInfo.imageSteps = []; // reset
    return routeInfo;
  }

  const useOriginal =
    options.useOriginal || routeInfo.urlInfo.query.useOriginal === 'true';

  // forward original image if no operation on image and useOriginal query or option
  if (routeInfo.imageSteps.length === 0 && useOriginal) {
    routeInfo.useOriginal = true;
    return routeInfo;
  }

  routeInfo.flatSteps = flattenSteps(routeInfo.imageSteps);

  if (!routeInfo.flatSteps.format) {
    // if WebP is not enabled or supported by browser, use appropriate lossless or lossy fallback format
    const fallbackFormat = routeInfo.flatSteps.lossless ? 'png' : 'jpeg';
    if (
      routeInfo.urlInfo.query.download !== undefined ||
      routeInfo.flatSteps.progressive
    ) {
      // force fallback if downloading or progressive
      routeInfo.flatSteps.format = { name: 'format', format: fallbackFormat };
    } else {
      // use user agent optimized format if format not already provided in request
      const useAVIF =
        options.supportAVIF &&
        req.headers.accept &&
        /image\/avif/.test(req.headers.accept);
      const useWebP =
        options.supportWebP &&
        req.headers.accept &&
        /image\/webp/.test(req.headers.accept) &&
        !/^win/.test(process.platform);
      var fmt = useAVIF ? 'avif' : useWebP ? 'webp' : fallbackFormat;

      routeInfo.flatSteps.format = { name: 'format', format: fmt };
    }
    routeInfo.imageSteps.push(routeInfo.flatSteps.format);
  }

  if (!routeInfo.flatSteps.metadata) {
    // always use metadata step if one is not provided
    routeInfo.flatSteps.metadata = { name: 'metadata', enabled: 'true' };
    routeInfo.imageSteps.push(routeInfo.flatSteps.metadata);
  }

  if (!routeInfo.flatSteps.rotate) {
    // enforce auto-rotation to account for orientation
    // adding this here also auto-corrects existing images by bypassing cache
    // prepend to beginning of steps to avoid changes in aspect from impacting rest of operations
    routeInfo.flatSteps.rotate = { name: 'rotate', degrees: 'auto' };
    routeInfo.imageSteps.splice(0, 0, routeInfo.flatSteps.rotate);
  }

  // backward compatibility to merge steps due to breaking change in sharp
  // DEPRECATION NOTICE!!!
  if (routeInfo.flatSteps.interpolation && routeInfo.flatSteps.resize) {
    routeInfo.flatSteps.resize.interpolator =
      routeInfo.flatSteps.interpolation.interpolator;
  }

  // if useOriginal is supplied, modify the hash to avoid collision with non-original with same steps
  const imageSteps = useOriginal
    ? [...routeInfo.imageSteps, { useOriginal }]
    : routeInfo.imageSteps;

  routeInfo.hashFromSteps = helpers.imageSteps.getHashFromSteps(imageSteps);

  return routeInfo;
};

p.getStepsFromObject = function (obj, options) {
  var steps = [];

  Object.keys(obj).forEach((key) => {
    if (!obj.hasOwnProperty(key)) {
      return;
    }
    var val = _.merge({ name: key }, obj[key]);

    if (key === 'format' && val.format === 'webp' && !options.supportWebP) {
      val.format = 'jpeg';
    }

    steps.push(val);
  });

  return steps;
};

function getContentType(req, routeInfo) {
  var contentType = mime.getType(routeInfo.originalPath);
  if (
    (!/image/i.test(contentType) || /image\/svg/i.test(contentType)) &&
    contentType !== 'application/octet-stream'
  ) {
    // if non-image, return known content type
    return contentType;
  }

  // content type unknown, assume image
  // return undefined
}

function getImageStepsFromRoute(imageStepsStr) {
  if (!imageStepsStr) return [];
  var imageSteps = imageStepsStr.split(this.options.cmdKeyDelimiter);

  var $this = this;
  return imageSteps.map(function (stepStr) {
    // format: crop=t:15,l:10,w:-10,h:-15
    const stepParts = stepStr.split($this.options.cmdValDelimiter);
    const shortName = stepParts[0];

    const cmdConfig = $this.options.commands[shortName];
    const stepConfig = cmdConfig ? null : $this.options.steps[shortName];
    const config = cmdConfig || stepConfig;
    if (!config) {
      throw new Error('Unsupported step: ' + stepStr);
    }

    const step = {
      command: cmdConfig ? true : false,
      name: config.name, // use full name from config
    };

    if (stepParts.length < 2) {
      return step;
    }

    var stepParams = stepParts[1].split($this.options.paramKeyDelimiter);
    stepParams.forEach(function (stepParam) {
      var paramParts = stepParam.split($this.options.paramValDelimiter);
      var paramName = paramParts[0];
      var fullParamName = config[paramName];
      if (!fullParamName) {
        throw new Error(
          'Unsupported param ' + paramName + ' in step ' + stepStr
        );
      }
      if (paramParts.length >= 2) {
        step[fullParamName] = paramParts[1];
      } else {
        // use a truthy value if key exists with no value
        step[fullParamName] = true;
      }
    });

    return step;
  });
}

function flattenSteps(steps) {
  return steps.reduce((ctx, s) => {
    ctx[s.name] = s;
    return ctx;
  }, {});
}
