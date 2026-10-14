import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

await test('current housing export resolves timezone names once and scales to 9,028 synthetic records',async context=>{
  const db=new PGlite(),colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='11111111-1111-4111-8111-111111111111';
  try{
    await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
    for(const file of ['schema.sql','functions/manage-colony-users/membership.sql','export-permissions.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
    await db.query('insert into auth.users values($1)',[owner]);
    await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3)',[colony,'Synthetic export scale lab',owner]);
    await db.query("insert into public.memberships(colony_id,user_id,role) values($1,$2,'owner')",[colony,owner]);
    const insert=async(type,count,payload)=>db.query(`insert into public.entity_records(colony_id,entity_type,entity_id,payload,created_by,updated_by)
      select $1,$2,g::text,${payload},$3,$3 from generate_series(1,$4::integer) g`,[colony,type,owner,count]);
    await insert('mice',3280,"jsonb_build_object('mouse_sid',g::text,'state',case when g<=242 then 'Stock' else 'Ended' end,'cage_sid',((g%91)+1)::text,'date_of_birth','2020-01-01')");
    await insert('cages',3088,"jsonb_build_object('cage_sid',g::text,'state',case when g<=91 then 'Active' else 'Inactive' end,'location_id',case when g<=115 then g::text else null end)");
    await insert('locations',115,"jsonb_build_object('location_id',g::text,'room_id','1','rack_id','1','label','P'||g::text,'record_origin','app_created')");
    await insert('rooms',1,"jsonb_build_object('room_id',g::text,'name','Synthetic room')");
    await insert('racks',1,"jsonb_build_object('rack_id',g::text,'room_id','1','name','Synthetic rack')");
    await insert('light_events',1347,"jsonb_build_object('event_id',g::text,'start_date','2020-01-01','end_date',case when g%2=0 then '2020-02-01' else null end,'timezone',case g%3 when 0 then 'Asia/Taipei' when 1 then 'Pacific/Honolulu' else 'invalid timezone' end,'location_id',((g%115)+1)::text)");
    await insert('husbandry_events',1196,"jsonb_build_object('event_id',g::text,'event_date','2020-01-01','event_type','Observation')");
    const query='select public.export_records($1,\'current_housing\',null,null,null,$2,250) result';
    const authorization=async()=>{await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);};
    await authorization();
    let offset=0;const rows=[],start=performance.now();
    while(true){const page=(await db.query(query,[colony,offset])).rows[0].result;rows.push(...page.rows);if(page.next_offset===null)break;offset=page.next_offset;}
    const elapsed=performance.now()-start;
    assert.equal(new Set(rows.map(r=>r.entity_type+'/'+r.entity_id)).size,rows.length);
    assert.equal(rows.filter(r=>r.entity_type==='mice').length,242);
    assert.equal(rows.filter(r=>r.entity_type==='cages').length,115);
    assert.equal(rows.filter(r=>r.entity_type==='locations').length,115);
    assert.equal(rows.filter(r=>r.entity_type==='light_events').length,674);
    assert.equal(rows.length,1148);
    context.diagnostic(`All five pages: ${Math.round(elapsed)} ms; ${rows.length} verified rows from 9028 source records.`);
    await db.exec('reset role');
    const helper=(await db.query("select pg_get_functiondef('colony_private.export_light_current(jsonb,date)'::regprocedure) body")).rows[0].body;
    assert(!helper.includes('pg_timezone_names'),'Per-record helper must not enumerate timezone names');
    if(process.env.EXPORT_BASELINE_SQL){
      await db.exec(await readFile(process.env.EXPORT_BASELINE_SQL,'utf8'));
      await authorization();const began=performance.now(),old=(await db.query(query,[colony,0])).rows[0].result;
      context.diagnostic(`Previous migration first page: ${Math.round(performance.now()-began)} ms.`);
      assert.deepEqual(old.rows,rows.slice(0,250));
    }
  }finally{await db.close();}
});
