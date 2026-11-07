/* TEST FIXTURE: trimmed from CPS_ASEC_ASCII_REPWGT_2026.SAS (recorded 2026-11-04); the totals below are
   recomputed over the 78 records kept in trimmed_asec2026_repwgt.dat.gz. */
/* This code is for documentation of the record layout for
the ASCII replicate weight code for the 2026 ASEC Data
*/

filename link
'CPS_ASEC_ASCII_REPWGT_2026.DAT';

filename replist
'CPS_ASEC_ASCII_REPWGT_2026.LST';

* Add SAS library;
libname sas '.';

data sas.repwgt_2026;
   infile link lrecl=1456;
   input
      @1  pwwgt0 f9.4
      @10  pwwgt1 f9.4
      @19  pwwgt2 f9.4
      @28  pwwgt3 f9.4
      @37  pwwgt4 f9.4
      @46  pwwgt5 f9.4
      @55  pwwgt6 f9.4
      @64  pwwgt7 f9.4
      @73  pwwgt8 f9.4
      @82  pwwgt9 f9.4
      @91  pwwgt10 f9.4
      @100  pwwgt11 f9.4
      @109  pwwgt12 f9.4
      @118  pwwgt13 f9.4
      @127  pwwgt14 f9.4
      @136  pwwgt15 f9.4
      @145  pwwgt16 f9.4
      @154  pwwgt17 f9.4
      @163  pwwgt18 f9.4
      @172  pwwgt19 f9.4
      @181  pwwgt20 f9.4
      @190  pwwgt21 f9.4
      @199  pwwgt22 f9.4
      @208  pwwgt23 f9.4
      @217  pwwgt24 f9.4
      @226  pwwgt25 f9.4
      @235  pwwgt26 f9.4
      @244  pwwgt27 f9.4
      @253  pwwgt28 f9.4
      @262  pwwgt29 f9.4
      @271  pwwgt30 f9.4
      @280  pwwgt31 f9.4
      @289  pwwgt32 f9.4
      @298  pwwgt33 f9.4
      @307  pwwgt34 f9.4
      @316  pwwgt35 f9.4
      @325  pwwgt36 f9.4
      @334  pwwgt37 f9.4
      @343  pwwgt38 f9.4
      @352  pwwgt39 f9.4
      @361  pwwgt40 f9.4
      @370  pwwgt41 f9.4
      @379  pwwgt42 f9.4
      @388  pwwgt43 f9.4
      @397  pwwgt44 f9.4
      @406  pwwgt45 f9.4
      @415  pwwgt46 f9.4
      @424  pwwgt47 f9.4
      @433  pwwgt48 f9.4
      @442  pwwgt49 f9.4
      @451  pwwgt50 f9.4
      @460  pwwgt51 f9.4
      @469  pwwgt52 f9.4
      @478  pwwgt53 f9.4
      @487  pwwgt54 f9.4
      @496  pwwgt55 f9.4
      @505  pwwgt56 f9.4
      @514  pwwgt57 f9.4
      @523  pwwgt58 f9.4
      @532  pwwgt59 f9.4
      @541  pwwgt60 f9.4
      @550  pwwgt61 f9.4
      @559  pwwgt62 f9.4
      @568  pwwgt63 f9.4
      @577  pwwgt64 f9.4
      @586  pwwgt65 f9.4
      @595  pwwgt66 f9.4
      @604  pwwgt67 f9.4
      @613  pwwgt68 f9.4
      @622  pwwgt69 f9.4
      @631  pwwgt70 f9.4
      @640  pwwgt71 f9.4
      @649  pwwgt72 f9.4
      @658  pwwgt73 f9.4
      @667  pwwgt74 f9.4
      @676  pwwgt75 f9.4
      @685  pwwgt76 f9.4
      @694  pwwgt77 f9.4
      @703  pwwgt78 f9.4
      @712  pwwgt79 f9.4
      @721  pwwgt80 f9.4
      @730  pwwgt81 f9.4
      @739  pwwgt82 f9.4
      @748  pwwgt83 f9.4
      @757  pwwgt84 f9.4
      @766  pwwgt85 f9.4
      @775  pwwgt86 f9.4
      @784  pwwgt87 f9.4
      @793  pwwgt88 f9.4
      @802  pwwgt89 f9.4
      @811  pwwgt90 f9.4
      @820  pwwgt91 f9.4
      @829  pwwgt92 f9.4
      @838  pwwgt93 f9.4
      @847  pwwgt94 f9.4
      @856  pwwgt95 f9.4
      @865  pwwgt96 f9.4
      @874  pwwgt97 f9.4
      @883  pwwgt98 f9.4
      @892  pwwgt99 f9.4
      @901  pwwgt100 f9.4
      @910  pwwgt101 f9.4
      @919  pwwgt102 f9.4
      @928  pwwgt103 f9.4
      @937  pwwgt104 f9.4
      @946  pwwgt105 f9.4
      @955  pwwgt106 f9.4
      @964  pwwgt107 f9.4
      @973  pwwgt108 f9.4
      @982  pwwgt109 f9.4
      @991  pwwgt110 f9.4
      @1000  pwwgt111 f9.4
      @1009  pwwgt112 f9.4
      @1018  pwwgt113 f9.4
      @1027  pwwgt114 f9.4
      @1036  pwwgt115 f9.4
      @1045  pwwgt116 f9.4
      @1054  pwwgt117 f9.4
      @1063  pwwgt118 f9.4
      @1072  pwwgt119 f9.4
      @1081  pwwgt120 f9.4
      @1090  pwwgt121 f9.4
      @1099  pwwgt122 f9.4
      @1108  pwwgt123 f9.4
      @1117  pwwgt124 f9.4
      @1126  pwwgt125 f9.4
      @1135  pwwgt126 f9.4
      @1144  pwwgt127 f9.4
      @1153  pwwgt128 f9.4
      @1162  pwwgt129 f9.4
      @1171  pwwgt130 f9.4
      @1180  pwwgt131 f9.4
      @1189  pwwgt132 f9.4
      @1198  pwwgt133 f9.4
      @1207  pwwgt134 f9.4
      @1216  pwwgt135 f9.4
      @1225  pwwgt136 f9.4
      @1234  pwwgt137 f9.4
      @1243  pwwgt138 f9.4
      @1252  pwwgt139 f9.4
      @1261  pwwgt140 f9.4
      @1270  pwwgt141 f9.4
      @1279  pwwgt142 f9.4
      @1288  pwwgt143 f9.4
      @1297  pwwgt144 f9.4
      @1306  pwwgt145 f9.4
      @1315  pwwgt146 f9.4
      @1324  pwwgt147 f9.4
      @1333  pwwgt148 f9.4
      @1342  pwwgt149 f9.4
      @1351  pwwgt150 f9.4
      @1360  pwwgt151 f9.4
      @1369  pwwgt152 f9.4
      @1378  pwwgt153 f9.4
      @1387  pwwgt154 f9.4
      @1396  pwwgt155 f9.4
      @1405  pwwgt156 f9.4
      @1414  pwwgt157 f9.4
      @1423  pwwgt158 f9.4
      @1432  pwwgt159 f9.4
      @1441  pwwgt160 f9.4
      @1450 h_seq f5.0
      @1455 pppos $char2.;
run;

/* SUM of Weights for Verification:

All replicate weights, PWWGT0 - PWWGT160, should
be slightly different due to the inclusion of Armed Forces
members in the ASEC estimates.  Use these totals to
verify that your file is created correctly.

   PWWGT0 =     23955.6785
   PWWGT1 =     23878.2337
   PWWGT2 =     22870.2234
   PWWGT3 =     24443.4676
   PWWGT4 =     23369.3000
   PWWGT5 =     24226.6704
   PWWGT6 =     25140.5972
   PWWGT7 =     22455.5789
   PWWGT8 =     22182.9491
   PWWGT9 =     25040.6696
   PWWGT10 =    27354.0531
   PWWGT11 =    24100.1591
   PWWGT12 =    21488.9878
   PWWGT13 =    20617.5367
   PWWGT14 =    25205.7821
   PWWGT15 =    23036.7860
   PWWGT16 =    21458.3000
   PWWGT17 =    26280.8000
   PWWGT18 =    25439.2435
   PWWGT19 =    26107.8309
   PWWGT20 =    22962.0657
   PWWGT21 =    25283.7141
   PWWGT22 =    25147.9365
   PWWGT23 =    23850.9789
   PWWGT24 =    24279.5426
   PWWGT25 =    23078.3983
   PWWGT26 =    22463.6820
   PWWGT27 =    25469.6536
   PWWGT28 =    23887.8430
   PWWGT29 =    22736.5771
   PWWGT30 =    23069.1389
   PWWGT31 =    22456.3375
   PWWGT32 =    27687.6002
   PWWGT33 =    25311.4755
   PWWGT34 =    22301.8685
   PWWGT35 =    24207.6011
   PWWGT36 =    25543.3483
   PWWGT37 =    19581.3165
   PWWGT38 =    21492.4222
   PWWGT39 =    23877.3386
   PWWGT40 =    24447.6552
   PWWGT41 =    26965.7860
   PWWGT42 =    22036.6158
   PWWGT43 =    22857.6772
   PWWGT44 =    24576.0735
   PWWGT45 =    26936.3762
   PWWGT46 =    23826.3706
   PWWGT47 =    20456.7002
   PWWGT48 =    23584.4575
   PWWGT49 =    26360.4334
   PWWGT50 =    25386.9499
   PWWGT51 =    26915.7121
   PWWGT52 =    23901.3947
   PWWGT53 =    21661.0007
   PWWGT54 =    24706.9567
   PWWGT55 =    22271.0968
   PWWGT56 =    22323.2276
   PWWGT57 =    25510.9637
   PWWGT58 =    25664.6780
   PWWGT59 =    24206.8788
   PWWGT60 =    24897.1441
   PWWGT61 =    23359.5698
   PWWGT62 =    26359.6586
   PWWGT63 =    23398.4921
   PWWGT64 =    23195.6799
   PWWGT65 =    24558.0888
   PWWGT66 =    21806.6305
   PWWGT67 =    27970.0170
   PWWGT68 =    21327.0237
   PWWGT69 =    25082.2873
   PWWGT70 =    22762.3781
   PWWGT71 =    22552.3258
   PWWGT72 =    26162.4947
   PWWGT73 =    25730.5836
   PWWGT74 =    20816.4530
   PWWGT75 =    22241.8635
   PWWGT76 =    25141.9562
   PWWGT77 =    21072.3872
   PWWGT78 =    20259.4186
   PWWGT79 =    25003.9613
   PWWGT80 =    25287.4442
   PWWGT81 =    23601.0624
   PWWGT82 =    21083.3522
   PWWGT83 =    22567.8761
   PWWGT84 =    23966.7497
   PWWGT85 =    24021.8527
   PWWGT86 =    23364.7157
   PWWGT87 =    23938.0184
   PWWGT88 =    22489.0859
   PWWGT89 =    23387.5019
   PWWGT90 =    24364.6740
   PWWGT91 =    24813.4488
   PWWGT92 =    20582.9591
   PWWGT93 =    21980.6550
   PWWGT94 =    22899.3290
   PWWGT95 =    24751.0467
   PWWGT96 =    23142.8417
   PWWGT97 =    27265.2172
   PWWGT98 =    26337.7009
   PWWGT99 =    24474.2678
   PWWGT100 =   23880.3743
   PWWGT101 =   26518.7452
   PWWGT102 =   27203.3906
   PWWGT103 =   22632.8273
   PWWGT104 =   24773.4479
   PWWGT105 =   25783.3122
   PWWGT106 =   23103.2667
   PWWGT107 =   27339.2741
   PWWGT108 =   23233.4734
   PWWGT109 =   23676.0410
   PWWGT110 =   21511.2230
   PWWGT111 =   23241.8714
   PWWGT112 =   25935.0206
   PWWGT113 =   22631.9966
   PWWGT114 =   22185.1985
   PWWGT115 =   24925.4870
   PWWGT116 =   27066.3934
   PWWGT117 =   22727.2735
   PWWGT118 =   24273.6365
   PWWGT119 =   26190.0008
   PWWGT120 =   23984.3262
   PWWGT121 =   25125.6536
   PWWGT122 =   23541.5997
   PWWGT123 =   23069.2598
   PWWGT124 =   24313.6788
   PWWGT125 =   24105.4622
   PWWGT126 =   22216.1942
   PWWGT127 =   21368.2899
   PWWGT128 =   22071.6350
   PWWGT129 =   23138.4133
   PWWGT130 =   24670.1557
   PWWGT131 =   24982.9541
   PWWGT132 =   19503.6803
   PWWGT133 =   21570.8391
   PWWGT134 =   26831.7959
   PWWGT135 =   25029.6327
   PWWGT136 =   23008.2229
   PWWGT137 =   24908.7415
   PWWGT138 =   26073.0914
   PWWGT139 =   25744.8518
   PWWGT140 =   23676.5554
   PWWGT141 =   24105.5227
   PWWGT142 =   26418.5289
   PWWGT143 =   23133.0850
   PWWGT144 =   23264.0570
   PWWGT145 =   23592.5786
   PWWGT146 =   21789.3327
   PWWGT147 =   26296.5054
   PWWGT148 =   24371.3389
   PWWGT149 =   21847.4051
   PWWGT150 =   21093.4030
   PWWGT151 =   22549.8947
   PWWGT152 =   25012.8412
   PWWGT153 =   26362.0034
   PWWGT154 =   21483.5713
   PWWGT155 =   25251.5064
   PWWGT156 =   24922.6866
   PWWGT157 =   22335.4052
   PWWGT158 =   22574.8383
   PWWGT159 =   25729.6040
   PWWGT160 =   24864.9991
*/

%macro total;
data _null_;
   retain tot_pwwgt0-tot_pwwgt160 0;
   set sas.repwgt_2026 end = last;
   %do i = 0 %to 160;
      tot_pwwgt&i + pwwgt&i;
   %end;
   if last then do;
      file replist;
      put 'Sum of replicate weights';
      put;
      %do i = 0 %to 160;
          put "   PWWGT&i = " @16 tot_pwwgt&i f15.4;
      %end;
   end;
run;
%mend total;
%total;
