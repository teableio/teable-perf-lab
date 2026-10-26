import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

var profile = __ENV.AI_PROFILE || 'mock';
var url =
  __ENV.AI_PROXY_URL || 'http://localhost:3000/api/v1/ai-proxy/v1/chat/completions';
var token = __ENV.AI_PROXY_TOKEN || __ENV.TOKEN || '';
var model = __ENV.AI_MODEL || 'mock-model';
var maxTokens = Number(__ENV.AI_MAX_TOKENS || 16);
var requests = Number(__ENV.AI_REQUESTS || (profile === 'canary' ? 20 : 100));
var vus = Number(__ENV.AI_VUS || (profile === 'canary' ? 1 : 10));
var prompt = __ENV.AI_PROMPT || 'Return the word ok.';

function scenarioFor(profile) {
  if (profile === 'canary') {
    return {
      ai_canary: {
        executor: 'per-vu-iterations',
        vus: 1,
        iterations: requests,
        maxDuration: '10m',
      },
    };
  }
  return {
    ai_mock: {
      executor: 'shared-iterations',
      vus: vus,
      iterations: requests,
      maxDuration: '5m',
    },
  };
}

export var options = {
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)', 'max'],
  scenarios: scenarioFor(profile),
  thresholds: {
    http_req_failed: ['rate<0.02'],
    'ai_request_failures': profile === 'canary' ? ['count<2'] : ['count<5'],
    'ai_request_duration': profile === 'canary' ? ['p(95)<10000'] : ['p(95)<500'],
  },
  userAgent: 'teable-ai-stress/1.0',
};

var aiDuration = new Trend('ai_request_duration', true);
var aiFailures = new Counter('ai_request_failures');
var aiTokens = new Counter('ai_tokens_total');

export default function () {
  var payload = {
    model: model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    stream: false,
  };
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;

  var res = http.post(url, JSON.stringify(payload), {
    headers: headers,
    tags: { ai_profile: profile, ai_model: model },
  });
  aiDuration.add(res.timings.duration, { ai_profile: profile });

  var body = null;
  try {
    body = res.json();
  } catch (e) {
    body = null;
  }

  var ok = check(res, {
    'status 200': function (r) {
      return r.status === 200;
    },
    'has choices': function () {
      return !!(body && body.choices && body.choices.length > 0);
    },
  });
  if (!ok) aiFailures.add(1, { ai_profile: profile });

  var total = body && body.usage ? body.usage.total_tokens : 0;
  if (total) aiTokens.add(total, { ai_profile: profile });
}

export function handleSummary(data) {
  var path = __ENV.SUMMARY_PATH || 'summary-ai.json';
  return { [path]: JSON.stringify(data, null, 2) };
}
