import { immutableJson, failAgent } from './contract.js';

export const SESSION_CAPABILITIES = immutableJson({
 claude: {model:true, effort:['low','medium','high','xhigh','max'], nativeTokens:true, nativeCostEstimate:true, contextOccupancy:false},
 codex: {model:true, effort:['none','minimal','low','medium','high','xhigh','max','ultra'], nativeTokens:false, nativeCostEstimate:false, contextOccupancy:false},
});

// These are requested CLI settings. Provider/model-specific restrictions may reject
// or clamp them; help probes establish option support, not effective model effort.
export function selectionArguments(kind, input) {
 if(input===undefined)return [];
 const selection=immutableJson(input);
 const capabilities=SESSION_CAPABILITIES[kind];
 if(!capabilities || selection.harness!==kind || selection.recommendationOnly!==false
  || typeof selection.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(selection.model)
  || !capabilities.effort.includes(selection.effort)) failAgent('template-invalid');
 return Object.freeze(['--model',selection.model,...(kind==='claude'?['--effort',selection.effort]:['--config',`model_reasoning_effort="${selection.effort}"`])]);
}

export function sessionTelemetry(provider, usage) {
 const unknown={value:null,source:'unavailable',assurance:'unknown'};
 const native=provider==='claude';
 const valid=usage && Number.isSafeInteger(usage.tokens) && usage.tokens>=0 && Number.isFinite(usage.costUsd) && usage.costUsd>=0;
 return immutableJson({version:1,provider,
  tokens:valid&&['claude','codex'].includes(provider)?{value:usage.tokens,source:native?'claude-modelUsage':'result-envelope',assurance:native?'native-measured':'model-reported'}:unknown,
  costUsd:valid&&native?{value:usage.costUsd,source:'claude-total_cost_usd',assurance:'native-estimate'}:unknown,
  contextUsedTokens:unknown,contextWindowTokens:unknown,
 });
}
