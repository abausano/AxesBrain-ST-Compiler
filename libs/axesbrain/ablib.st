(* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
 *
 * Libreria standard AxesBrain per la VM ST: blocchi IEC 61131-3 scritti da zero
 * secondo la norma (non derivati da STruC++), compilati insieme al programma.
 * Licenza MIT: i programmi che la usano restano liberi da qualunque vincolo.
 * I timer usano AB_TIME(): il tempo all'inizio della scansione, uguale per tutta
 * la scansione, fornito dalla VM.
 *)

FUNCTION AB_TIME : TIME
  {external native AB_TIME}
END_FUNCTION

(* Fronte di salita *)
FUNCTION_BLOCK R_TRIG
  VAR_INPUT CLK : BOOL; END_VAR
  VAR_OUTPUT Q : BOOL; END_VAR
  VAR M : BOOL; END_VAR
  Q := CLK AND NOT M;
  M := CLK;
END_FUNCTION_BLOCK

(* Fronte di discesa *)
FUNCTION_BLOCK F_TRIG
  VAR_INPUT CLK : BOOL; END_VAR
  VAR_OUTPUT Q : BOOL; END_VAR
  VAR M : BOOL := TRUE; END_VAR
  Q := NOT CLK AND NOT M;
  M := NOT CLK;
END_FUNCTION_BLOCK

(* Bistabile a prevalenza di set *)
FUNCTION_BLOCK SR
  VAR_INPUT S1 : BOOL; R : BOOL; END_VAR
  VAR_OUTPUT Q1 : BOOL; END_VAR
  Q1 := S1 OR (NOT R AND Q1);
END_FUNCTION_BLOCK

(* Bistabile a prevalenza di reset *)
FUNCTION_BLOCK RS
  VAR_INPUT S : BOOL; R1 : BOOL; END_VAR
  VAR_OUTPUT Q1 : BOOL; END_VAR
  Q1 := NOT R1 AND (S OR Q1);
END_FUNCTION_BLOCK

(* Contatore in avanti *)
FUNCTION_BLOCK CTU
  VAR_INPUT CU : BOOL; R : BOOL; PV : INT; END_VAR
  VAR_OUTPUT Q : BOOL; CV : INT; END_VAR
  VAR M : BOOL; END_VAR
  IF R THEN
    CV := 0;
  ELSIF CU AND NOT M AND CV < 32767 THEN
    CV := CV + 1;
  END_IF
  M := CU;
  Q := CV >= PV;
END_FUNCTION_BLOCK

(* Contatore all'indietro *)
FUNCTION_BLOCK CTD
  VAR_INPUT CD : BOOL; LD : BOOL; PV : INT; END_VAR
  VAR_OUTPUT Q : BOOL; CV : INT; END_VAR
  VAR M : BOOL; END_VAR
  IF LD THEN
    CV := PV;
  ELSIF CD AND NOT M AND CV > -32768 THEN
    CV := CV - 1;
  END_IF
  M := CD;
  Q := CV <= 0;
END_FUNCTION_BLOCK

(* Contatore avanti/indietro *)
FUNCTION_BLOCK CTUD
  VAR_INPUT CU : BOOL; CD : BOOL; R : BOOL; LD : BOOL; PV : INT; END_VAR
  VAR_OUTPUT QU : BOOL; QD : BOOL; CV : INT; END_VAR
  VAR MU : BOOL; MD : BOOL; END_VAR
  IF R THEN
    CV := 0;
  ELSIF LD THEN
    CV := PV;
  ELSE
    IF CU AND NOT MU AND CV < 32767 THEN CV := CV + 1; END_IF
    IF CD AND NOT MD AND CV > -32768 THEN CV := CV - 1; END_IF
  END_IF
  MU := CU;
  MD := CD;
  QU := CV >= PV;
  QD := CV <= 0;
END_FUNCTION_BLOCK

(* Ritardo all'eccitazione *)
FUNCTION_BLOCK TON
  VAR_INPUT IN : BOOL; PT : TIME; END_VAR
  VAR_OUTPUT Q : BOOL; ET : TIME; END_VAR
  VAR T0 : TIME; RUN : BOOL; END_VAR
  IF NOT IN THEN
    Q := FALSE; ET := T#0s; RUN := FALSE;
  ELSE
    IF NOT RUN THEN RUN := TRUE; T0 := AB_TIME(); END_IF
    ET := AB_TIME() - T0;
    IF ET >= PT THEN ET := PT; Q := TRUE; END_IF
  END_IF
END_FUNCTION_BLOCK

(* Ritardo alla diseccitazione *)
FUNCTION_BLOCK TOF
  VAR_INPUT IN : BOOL; PT : TIME; END_VAR
  VAR_OUTPUT Q : BOOL; ET : TIME; END_VAR
  VAR T0 : TIME; RUN : BOOL; END_VAR
  IF IN THEN
    Q := TRUE; ET := T#0s; RUN := FALSE;
  ELSIF Q THEN
    IF NOT RUN THEN RUN := TRUE; T0 := AB_TIME(); END_IF
    ET := AB_TIME() - T0;
    IF ET >= PT THEN ET := PT; Q := FALSE; END_IF
  END_IF
END_FUNCTION_BLOCK

(* Impulso di durata fissa *)
FUNCTION_BLOCK TP
  VAR_INPUT IN : BOOL; PT : TIME; END_VAR
  VAR_OUTPUT Q : BOOL; ET : TIME; END_VAR
  VAR T0 : TIME; M : BOOL; END_VAR
  IF NOT Q THEN
    IF IN AND NOT M THEN
      Q := TRUE; T0 := AB_TIME(); ET := T#0s;
    ELSIF NOT IN AND ET >= PT THEN
      ET := T#0s;
    END_IF
  END_IF
  IF Q THEN
    ET := AB_TIME() - T0;
    IF ET >= PT THEN ET := PT; Q := FALSE; END_IF
  END_IF
  M := IN;
END_FUNCTION_BLOCK
