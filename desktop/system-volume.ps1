$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDevices {
    [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IDeviceCallback callback);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IDeviceCallback callback);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDevice {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVolume {
    [PreserveSig] int RegisterControlChangeNotify(IVolumeCallback callback);
    [PreserveSig] int UnregisterControlChangeNotify(IVolumeCallback callback);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float value, ref Guid context);
    [PreserveSig] int SetMasterVolumeLevelScalar(float value, ref Guid context);
    [PreserveSig] int GetMasterVolumeLevel(out float value);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float value);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float value, ref Guid context);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float value, ref Guid context);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float value);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float value);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
}
[ComVisible(true), Guid("657804FA-D6AD-4496-8A60-352752AF4F89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVolumeCallback { [PreserveSig] int OnNotify(IntPtr data); }
[ComVisible(true), Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDeviceCallback {
    [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id, uint state);
    [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int OnDefaultDeviceChanged(int flow, int role, [MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string id, PropertyKey key);
}
[StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid format; public uint id; }
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public class VolumeCallback : IVolumeCallback {
    readonly CodioVolume owner;
    readonly int generation;
    public VolumeCallback(CodioVolume owner, int generation) { this.owner = owner; this.generation = generation; }
    public int OnNotify(IntPtr pointer) {
        try {
            ThreadPool.QueueUserWorkItem(delegate { owner.Notify(generation); });
        } catch { }
        return 0;
    }
}
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public class DeviceCallback : IDeviceCallback {
    readonly CodioVolume owner;
    public DeviceCallback(CodioVolume owner) { this.owner = owner; }
    public int OnDeviceStateChanged(string id, uint state) { return 0; }
    public int OnDeviceAdded(string id) { return 0; }
    public int OnDeviceRemoved(string id) { return 0; }
    public int OnPropertyValueChanged(string id, PropertyKey key) { return 0; }
    public int OnDefaultDeviceChanged(int flow, int role, string id) {
        if (flow == 0 && role == 0) ThreadPool.QueueUserWorkItem(delegate { owner.Rebind(); });
        return 0;
    }
}
public class CodioVolume : IDisposable {
    readonly object gate = new object();
    readonly object output = new object();
    readonly Guid eventContext = new Guid("a67f1988-04bc-4ca7-87ce-9ac491998982");
    IDevices devices;
    IVolume volume;
    VolumeCallback volumeCallback;
    DeviceCallback deviceCallback;
    int generation;
    bool disposed;

    static void Check(int code) { Marshal.ThrowExceptionForHR(code); }
    void Send(string type, int id, float value, bool muted, string error) {
        string status = error == null
            ? "\"available\":true,\"volume\":" + Math.Round(Math.Max(0, Math.Min(100, value * 100)), MidpointRounding.AwayFromZero).ToString(CultureInfo.InvariantCulture) + ",\"muted\":" + (muted ? "true" : "false")
            : "\"available\":false,\"volume\":null,\"muted\":false,\"error\":\"" + error + "\"";
        lock (output) { Console.Out.WriteLine("{\"type\":\"" + type + "\",\"id\":" + id + "," + status + "}"); Console.Out.Flush(); }
    }
    void Snapshot(string type, int id) {
        if (volume == null) { Send(type, id, 0, false, "SYSTEM_VOLUME_UNAVAILABLE"); return; }
        float value; bool muted;
        Check(volume.GetMasterVolumeLevelScalar(out value));
        Check(volume.GetMute(out muted));
        Send(type, id, value, muted, null);
    }
    void Unbind() {
        generation++;
        if (volume != null) {
            try { volume.UnregisterControlChangeNotify(volumeCallback); } catch { }
            Marshal.ReleaseComObject(volume);
            volume = null; volumeCallback = null;
        }
    }
    void Bind() {
        Unbind();
        IDevice device = null;
        try {
            Check(devices.GetDefaultAudioEndpoint(0, 0, out device));
            Guid iid = typeof(IVolume).GUID;
            object instance;
            Check(device.Activate(ref iid, 23, IntPtr.Zero, out instance));
            volume = (IVolume)instance;
            volumeCallback = new VolumeCallback(this, generation);
            Check(volume.RegisterControlChangeNotify(volumeCallback));
        } finally { if (device != null) Marshal.ReleaseComObject(device); }
    }
    public void Rebind() {
        lock (gate) {
            if (disposed) return;
            try { Bind(); Snapshot("change", 0); }
            catch { Unbind(); Send("change", 0, 0, false, "SYSTEM_VOLUME_UNAVAILABLE"); }
        }
    }
    public void Notify(int token) {
        lock (gate) {
            if (disposed || token != generation) return;
            // Read the current endpoint on a worker: queued callbacks must not replay stale slider/mute snapshots.
            try { Snapshot("change", 0); }
            catch { Send("change", 0, 0, false, "SYSTEM_VOLUME_UNAVAILABLE"); }
        }
    }
    void Command(string line) {
        string[] fields = line.Split(' ');
        int id;
        if (fields.Length < 2 || !Int32.TryParse(fields[1], out id) || id <= 0) return;
        lock (gate) {
            try {
                if (volume == null) Bind();
                if (fields[0] == "set" && fields.Length == 3) {
                    float value;
                    if (!Single.TryParse(fields[2], NumberStyles.Float, CultureInfo.InvariantCulture, out value) || Single.IsNaN(value) || Single.IsInfinity(value) || value < 0 || value > 100) {
                        Send("response", id, 0, false, "SYSTEM_VOLUME_INVALID_VALUE"); return;
                    }
                    Guid context = eventContext;
                    Check(volume.SetMasterVolumeLevelScalar(value / 100, ref context));
                    // Positive volume is an explicit request to hear music; zero does not overwrite Windows mute state.
                    if (value > 0) Check(volume.SetMute(false, ref context));
                } else if (fields[0] == "mute" && fields.Length == 3 && (fields[2] == "0" || fields[2] == "1")) {
                    Guid context = eventContext;
                    Check(volume.SetMute(fields[2] == "1", ref context));
                } else if (fields[0] != "get" || fields.Length != 2) {
                    Send("response", id, 0, false, "SYSTEM_VOLUME_PROTOCOL"); return;
                }
                Snapshot("response", id);
            } catch { Unbind(); Send("response", id, 0, false, "SYSTEM_VOLUME_UNAVAILABLE"); }
        }
    }
    public static void Run() {
        using (CodioVolume bridge = new CodioVolume()) {
            try {
                bridge.devices = (IDevices)new DeviceEnumerator();
                bridge.deviceCallback = new DeviceCallback(bridge);
                Check(bridge.devices.RegisterEndpointNotificationCallback(bridge.deviceCallback));
                bridge.Bind();
                bridge.Snapshot("ready", 0);
            } catch { bridge.Unbind(); bridge.Send("ready", 0, 0, false, "SYSTEM_VOLUME_UNAVAILABLE"); }
            string line;
            while ((line = Console.In.ReadLine()) != null && line != "quit") bridge.Command(line);
        }
    }
    public void Dispose() {
        lock (gate) {
            disposed = true;
            Unbind();
            if (devices != null) {
                try { devices.UnregisterEndpointNotificationCallback(deviceCallback); } catch { }
                Marshal.ReleaseComObject(devices);
                devices = null; deviceCallback = null;
            }
        }
    }
}
'@
[CodioVolume]::Run()
} catch {
    [Console]::Out.WriteLine('{"type":"ready","id":0,"available":false,"volume":null,"muted":false,"error":"SYSTEM_VOLUME_HELPER_START"}')
}
