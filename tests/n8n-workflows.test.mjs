import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('updated n8n exports connect memory before drafting and guard supplier dispatch',async()=>{
  const workflows=[];
  for(const name of ['workflow 1.json','workflow 2 - draft actions.json','workflow 3 - send reply.json','workflow 4 - supplier pricing.json']){
    const workflow=JSON.parse(await readFile(new URL('../'+name,import.meta.url),'utf8'));workflows.push(workflow);
    const names=new Set(workflow.nodes.map(n=>n.name));assert.equal(names.size,workflow.nodes.length);assert.equal(workflow.active,false);
    for(const [source,connections] of Object.entries(workflow.connections)){
      assert.ok(names.has(source));for(const branches of Object.values(connections))for(const edges of branches)for(const edge of edges)assert.ok(names.has(edge.node),`${name}: missing ${edge.node}`);
    }
    for(const node of workflow.nodes)if(node.parameters.jsCode)assert.doesNotThrow(()=>new (Object.getPrototypeOf(async function(){}).constructor)(node.parameters.jsCode),node.name);
  }
  for(const workflow of workflows.slice(0,2))assert.match(workflow.nodes.find(n=>n.name==='Load Email Brain').parameters.query,/crm_ai_context/);
  assert.match(workflows[0].nodes.find(n=>n.name==='Save Dashboard Draft').parameters.query,/deleted_at IS NULL/);
  assert.match(workflows[2].nodes.find(n=>n.name==='Claim Draft for Send').parameters.query,/d.deleted_at IS NULL/);
  const supplier=workflows[3];
  assert.match(supplier.nodes.find(n=>n.name==='Claim Supplier Request').parameters.query,/crm_claim_supplier_request/);
  assert.equal(supplier.connections['Verify Supplier Recipient'].main[0][0].node,'Send Supplier Draft');
  assert.notEqual(supplier.nodes.find(n=>n.name==='Send Supplier Draft').retryOnFail,true);
  assert.equal(supplier.connections['Send Supplier Draft'].main[1][0].node,'Mark Supplier Uncertain');
});
