do $$ declare definition text;begin
 select pg_get_functiondef('public.crm_ai_context(uuid)'::regprocedure) into definition;
 if position('''classification''' in definition)=0 then
 definition:=replace(definition,'return jsonb_build_object(''identity''', 'return jsonb_build_object(''classification'',(select jsonb_build_object(''purpose'',t.topic,''source'',t.topic_source,''state'',t.classification_state,''relationship'',public.crm_correspondent_role(m.sender)) from public.email_threads t where t.id=p_thread_id),''identity''');
 execute definition;
 end if;
end $$;
notify pgrst,'reload schema';
