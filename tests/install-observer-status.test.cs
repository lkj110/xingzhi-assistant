using System;
using System.Management;

// Compile with ProcessObserver.cs and /main:ObserverCancellationOfflineTest.
// No observer is constructed; no WMI, fixture, application or model is started.
public static class ObserverCancellationOfflineTest {
    static int checks;
    static void Check(bool value) { checks++; if(!value)throw new Exception("Offline stop-status assertion " + checks); }
    public static int Main() {
        Check((int)ManagementStatus.CallCanceled == -2147217358);
        Check((int)ManagementStatus.OperationCanceled == 262150);
        foreach(var status in new [] {ManagementStatus.CallCanceled,ManagementStatus.OperationCanceled,ManagementStatus.NoError,ManagementStatus.AccessDenied,ManagementStatus.QueueOverflow,(ManagementStatus)Int32.MaxValue}) {
            foreach(bool requested in new [] {false,true})foreach(bool duplicate in new [] {false,true}) {
                bool cancellation=status==ManagementStatus.CallCanceled||status==ManagementStatus.OperationCanceled;
                Check(FoundationProcessObserver.ExpectedStop(requested,duplicate,status)==(requested&&!duplicate&&cancellation));
            }
        }
        Console.WriteLine("Offline enum checks passed: " + checks + "; WMI starts: 0");return 0;
    }
}
