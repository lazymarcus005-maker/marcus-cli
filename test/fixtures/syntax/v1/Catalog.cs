using System;

namespace Fixture.Catalog;

public enum ItemState
{
    Ready,
    Retired
}

public interface ICatalog<T>
{
    T Find(string key);
}

public readonly record struct CatalogKey(string Value);

public sealed class Catalog<T> : ICatalog<T>
{
    public string Name { get; set; }

    public Catalog(string name)
    {
        Name = name;
    }

    public T Find(string key)
    {
        throw new NotImplementedException();
    }
}
