(* Filtro degli I/O: nel .stc devono finire solo INP2, OUT5 e M1_10. *)
PROGRAM Filtro
  OUT5 := INP2;
  M1_10 := NOT INP2;
END_PROGRAM
