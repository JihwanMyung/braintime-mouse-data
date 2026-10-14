import test from 'node:test';
import assert from 'node:assert/strict';
import {renderFamilyExplorer,familyHelpHTML} from '../web/family-explorer.js';
const locus={id:'bmal1',name:'Bmal1',kind:'flox',chromosome:'unknown',alleles:['+','fl']};
const mouse=(id,tag,extra={})=>({mouse_sid:id,physical_tag:tag,state:'Stock',sex:'Male',...extra});
const data=()=>({synthetic:true,tables:{mice:[mouse('1',"PB'-M1",{cage_tag:'Cage-1',sire_sids:['3'],dam_sids:['missing','4']}),mouse('2',"(P)B'-F2",{sex:'Female'}),mouse('3','P-M3',{state:'Ended'}),mouse('4',"B'-F4",{sex:'Female'}),mouse('5','B-M5',{genetic_profile:{schema_version:1,loci:[locus],calls:{bmal1:{alleles:['fl','fl'],evidence:'confirmed'}}}})],mouse_genes:[]}});
function harness(dataset=data()){
 const container={innerHTML:'',querySelector(){return null}},messages=[],original=structuredClone(dataset);let focus='1';
 const hooks={getFocus:()=>focus,setFocus:id=>focus=id,treeHTML:(m,depth)=>`<svg data-tree="${m.mouse_sid}" data-depth="${depth}"></svg>`,openMouse:id=>messages.push(['open',id]),reviewMouse:id=>messages.push(['review',id]),planTarget:d=>messages.push(['target',d]),help:()=>messages.push(['help']),zoom:action=>messages.push(['zoom',action])};
 renderFamilyExplorer(container,dataset,hooks);
 return {container,messages,dataset,original,get focus(){return focus},click(action,meta={}){container.onclick({target:{closest:()=>({dataset:{familyAction:action,...meta}})}})},change(field,value,meta={}){container.onchange({target:{value,checked:Boolean(value),dataset:{familyField:field,...meta}}})},input(value){container.oninput({target:{value,dataset:{familyField:'search'}}})},enter(){container.onkeydown({key:'Enter',target:{dataset:{familyField:'search'}},preventDefault(){}})}};
}
test('shorthand totals lead the page; live scope, uncertainty, full registry, combined groups and custom target are discoverable',()=>{
 const h=harness(),html=h.container.innerHTML;
 assert(html.indexOf('family-genotype-summary')<html.indexOf('family-filters'));
 for(const code of ['P','E','B','F','V','AD','A','32','Vg','Gt','96'])assert(html.includes(`data-code="${code}"`));
 assert.match(html,/4 matching mice/);assert.match(html,/Demo data/);assert.match(html,/Design target genotype/);
 h.click('code',{code:'P'});assert.match(h.container.innerHTML,/2 matching mice/);
 h.change('includeUncertain',false);assert.match(h.container.innerHTML,/1 matching mice/);
 h.change('scope','all');assert.match(h.container.innerHTML,/2 matching mice/);
 h.click('view',{view:'combinations'});assert.match(h.container.innerHTML,/Recorded combination/);
 h.click('clear');assert.match(h.container.innerHTML,/5 matching mice/);
 assert.deepEqual(h.dataset,h.original);
});
test('search, combined selection, external ancestors, unknown sex and reviewed filtering preserve focus context',()=>{
 const h=harness();h.input('Cage-1');h.enter();assert.match(h.container.innerHTML,/1 matching mice/);
 h.click('focus',{id:'3'});assert.equal(h.focus,'3');assert.match(h.container.innerHTML,/outside the current filters/);
 h.click('clear');h.change('evidence','confirmed');assert.match(h.container.innerHTML,/1 matching mice/);
 h.click('clear');h.click('view',{view:'combinations'});
 const key=h.container.innerHTML.match(/data-key="([^"]*)"/)?.[1].replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');assert(key);
 h.click('combination',{key});assert.match(h.container.innerHTML,/Selected combination/);assert.match(h.container.innerHTML,/Recorded genotype/);
 h.click('clear-combination');assert.match(h.container.innerHTML,/4 matching mice/);
});
test('target selection transfers intent only; reviewed source can seed dosage without saving records',()=>{
 const h=harness();h.click('code',{code:'B'});h.click('target-selected');assert.match(h.container.innerHTML,/<option value="carrier" selected>/);
 h.change('target','homozygous',{code:'B'});h.click('open-target');
 const draft=h.messages.find(x=>x[0]==='target')?.[1];assert(draft);assert.deepEqual(draft.targets.bmal1,{mode:'exact',alleles:['fl','fl']});
 assert.deepEqual(h.dataset,h.original);h.click('target-focus');assert.match(h.container.innerHTML,/uncertain calls are omitted/);
 h.click('review');assert.deepEqual(h.messages.at(-1),['review','1']);
 h.click('open-mouse');assert.deepEqual(h.messages.at(-1),['open','1']);
 h.change('generations','5');assert.match(h.container.innerHTML,/data-depth="4"/);
 h.click('zoom-in');assert.deepEqual(h.messages.at(-1),['zoom','zoom-in']);h.click('help');assert.deepEqual(h.messages.at(-1),['help']);
});
test('empty target and unsafe labels have safe visible handling; help states missing is unknown',()=>{
 const h=harness({tables:{mice:[mouse('x','<img onerror=evil>',{genotype:'<script>evil</script>'})]}});
 assert.doesNotMatch(h.container.innerHTML,/<img onerror|<script>evil/);
 h.click('open-target');assert.match(h.container.innerHTML,/role="alert"/);
 assert.match(familyHelpHTML(),/Omitted loci remain unknown/);assert.match(familyHelpHTML(),/Ai32 and Ai96 share Rosa26/);
});
test('shared reporter targets expose exact pairs and preserve compound custom genotypes',()=>{
 const h=harness();h.change('target','exact',{code:'32'});
 assert.match(h.container.innerHTML,/Ai32 target allele 1/);
 h.change('target-pair','Ai32',{code:'32',index:'0'});h.change('target-pair','Ai96',{code:'32',index:'1'});h.click('open-target');
 assert.deepEqual(h.messages.at(-1)[1].targets.rosa26,{mode:'exact',alleles:['Ai32','Ai96']});
 const custom={id:'custom',name:'Custom locus',kind:'other',chromosome:'1',alleles:['+','a','b']};
 const c=harness({tables:{mice:[mouse('1','Compound',{genetic_profile:{schema_version:1,loci:[custom],calls:{custom:{alleles:['a','b'],evidence:'confirmed'}}}})]}});
 c.click('target-focus');assert.match(c.container.innerHTML,/<option value="exact" selected>/);c.click('open-target');
 assert.deepEqual(c.messages.at(-1)[1].targets.custom,{mode:'exact',alleles:['a','b']});assert.deepEqual(c.dataset,c.original);
});
