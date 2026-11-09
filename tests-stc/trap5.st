(* Trappola: indice fuori limite nella seconda dimensione di un array di STRUCT. *)
TYPE Cella : STRUCT v : INT; s : STRING(8); END_STRUCT; END_TYPE
PROGRAM T5
  VAR m : ARRAY[1..2, 1..3] OF Cella; j : INT; giri : INT; END_VAR
  giri := giri + 1;
  j := giri + 1;
  m[2, j].v := giri;
  m[2, j].s := 'ok';
END_PROGRAM
